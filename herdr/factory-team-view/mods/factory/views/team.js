// The Team tab and the lane flow atop Workflows: a Herdr lane team (Lead plus lane builders in
// .tsf/lanes worktrees) as orchestration's `status.sh --json` reports it. No tokens: git and files only.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, appHome, exec, run as runCommand, terminals, theme } from "herdr";
import { TEXT, GroupHeader, Message, Stat, StatusDot } from "./ui.js";

export const TEAM_MS = 3000;

// The lane flow, and where each issue stage and each session sits on it.
const FLOW = ["discuss", "plan", "build", "ready", "land", "review", "finish"];
const ISSUE_AT = { queued: "plan", building: "build", ready: "ready", landed: "land", reviewed: "review" };
const PIP = { queued: "·", building: "▶", ready: "✓", landed: "✓", reviewed: "✓" };

const span = (s) => {
  if (s == null) return "–";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const peek = (address) => address && runCommand("terminal.peek", { terminal: address });
const title = (s) => s[0].toUpperCase() + s.slice(1);

function leadStage(team) {
  if (!team.issues.length) return "discuss";
  if (!team.lanes.length) return "plan";
  if (team.reviews.due.length) return "review";
  if (team.milestones.done.length && !team.milestones.left.length) return "finish";
  if (team.lanes.some((l) => l.stage === "ready")) return "land";
  return "build";
}

export const teamMethods = {
  // Where a team may be, best first: a live team whose Lead is in this space, this space's folder, then any
  // live team. A Lead often sits in another space than its project, so live teams come from the core's
  // builders (`builder-<lane>`): their folder, or their Lead's, with any .tsf/lanes/<lane> taken off.
  teamCandidates() {
    const strip = (f) => f?.replace(/\/\.tsf\/lanes(\/.*)?$/, "") || null;
    const all = terminals();
    const here = this.space()?.id;
    const live = [];
    for (const k of all) {
      if (!/^builder-/.test(k.name ?? "") || (k.state && k.state !== "live")) continue;
      const project = strip(k.cwd) ?? strip(all.find((x) => x.address === k.parent)?.cwd);
      if (project) live.push({ project, mine: agents().some((a) => a.address === k.parent && a.space === here) });
    }
    return [...new Set([...live.filter((x) => x.mine).map((x) => x.project), strip(this.folder()), ...live.map((x) => x.project)].filter(Boolean))];
  },

  // The first candidate with a team; else this space's (empty) reading.
  team() {
    const candidates = this.teamCandidates();
    const found = candidates.map((p) => this.teams?.[p]).find((t) => t && (t.lanes.length || t.issues.length));
    return found ?? this.teams?.[candidates[0]] ?? null;
  },

  loadTeam(cx) {
    const projects = this.teamCandidates();
    if (!projects.length || this.teamBusy) return;
    this.teamBusy = true;
    this.teamAt = Date.now();
    cx.spawn(async (cx) => {
      const script = `${appHome()}/mods/orchestration/harness/lanes/status.sh`;
      this.teamError = null;
      for (const project of projects)
        try {
          const r = await exec("sh", [script, "--json", project], { cwd: project, timeout: 20_000 });
          if (r.code !== 0) throw new Error(r.stderr?.trim() || "status.sh failed");
          (this.teams ??= {})[project] = JSON.parse(r.stdout);
        } catch (e) {
          if (projects.length === 1) this.teamError = e.message; // a stale candidate's failure isn't the team's
        }
      this.teamBusy = false;
      cx.notify();
    });
  },

  // The Lead is the builders' parent in the core.
  lead(team) {
    const all = terminals();
    for (const lane of team.lanes) {
      const parent = all.find((k) => k.address === lane.address)?.parent;
      if (parent) return all.find((k) => k.address === parent) ?? { address: parent };
    }
    return null;
  },

  teamHeader(team) {
    const t = theme();
    const { done, left } = team.milestones;
    const name = team.project.split("/").pop();
    return h_flex()
      .id("factory-team-header")
      .flex_none()
      .flex_wrap()
      .gap(10)
      .px(8)
      .py(8)
      .items_center()
      .child(div().font_medium().truncate().child(name))
      .child(
        Stat({
          id: "factory-team-milestones",
          label: "Milestones",
          value: `${done.length}/${done.length + left.length}`,
          color: left.length ? t.foreground : t.done,
          detail: [done.length && `Done ${done.join(" ")}`, left.length && `Left ${left.join(" ")}`]
            .filter(Boolean)
            .join(" · ") || "No milestones under issues/ yet",
        }),
      )
      .child(Stat({ id: "factory-team-time", label: "Time", value: span(team.elapsed_s), color: t.foreground, detail: "Since the Lead made .tsf" }))
      .when(team.cost != null, (el) =>
        el.child(
          Stat({
            id: "factory-team-cost",
            label: "Cost",
            value: `$${team.cost.toFixed(2)}`,
            color: t.foreground,
            detail: "Claude Code sessions in this project and its lanes since the run started",
          }),
        ),
      )
      .child(Stat({ id: "factory-team-lanes", label: "Lanes", value: String(team.lanes.length), color: t.foreground, detail: "Lane worktrees under .tsf/lanes" }));
  },

  laneRow(team, lane) {
    const t = theme();
    const stall = lane.flag === "STALL";
    const ids = team.issues.filter((i) => i.lane === lane.id).map((i) => i.id); // plan order
    const stageOf = (id) => team.issues.find((i) => i.id === id)?.stage ?? "queued";
    const pips = h_flex().gap(2).items_center();
    for (const id of ids) {
      const now = id === lane.current;
      const stage = stageOf(id);
      pips.child(
        div()
          .id(`factory-pip-${lane.id}-${id}`)
          .text_size(TEXT.caption)
          .text_color(now ? t.working : stage === "queued" ? t.dim : t.done)
          .tooltip(`${id}: ${stage}`)
          .child(now ? "▶" : PIP[stage]),
      );
    }
    const doing = lane.current
      ? `${lane.current} ${lane.stage}`
      : lane.stage === "ready"
        ? "ready to land"
        : lane.left.length
          ? `next ${lane.left[0]}`
          : lane.flag === "FREE"
            ? "free"
            : "all landed";
    return h_flex()
      .id(`factory-lane-${lane.id}`)
      .flex_none()
      .min_w(0)
      .px(8)
      .py(6)
      .gap(8)
      .items_start()
      .rounded(6)
      .when(Boolean(lane.address), (el) =>
        el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => peek(lane.address)),
      )
      .tooltip(lane.last ? `Last commit: ${lane.last}` : `Lane ${lane.id}`)
      .child(div().pt(5).child(StatusDot(stall ? "blocked" : lane.status ?? "unknown")))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .min_w(0)
              .items_center()
              .child(div().truncate().font_medium().child(lane.builder ?? `lane ${lane.id}`))
              .when(Boolean(lane.model), (el) => el.child(div().flex_none().text_size(TEXT.small).text_color(t.dim).child(lane.model)))
              .when(stall, (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.blocked)
                    .text_size(TEXT.badge)
                    .text_color(t.background)
                    .child("needs you"),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(8)
              .min_w(0)
              .items_center()
              .text_size(TEXT.small)
              .text_color(t.muted)
              .child(div().truncate().child(doing))
              .child(pips),
          ),
      )
      .child(
        v_flex()
          .flex_none()
          .items_end()
          .gap(2)
          .text_size(TEXT.small)
          .child(div().text_color(lane.ahead ? t.foreground : t.dim).child(`+${lane.ahead}`))
          .child(div().text_color(stall ? t.blocked : t.dim).child(span(lane.idle_s))),
      );
  },

  reviewsLine(team) {
    const t = theme();
    const { due, done, left } = team.reviews;
    const parts = [
      due.length && { text: `due ${due.join(" ")}`, color: t.blocked },
      done.filter((r) => r.clean).length && { text: `clean ${done.filter((r) => r.clean).map((r) => r.id).join(" ")}`, color: t.done },
      done.filter((r) => !r.clean).length && { text: `defects ${done.filter((r) => !r.clean).map((r) => r.id).join(" ")}`, color: t.blocked },
      left.filter((id) => !due.includes(id)).length && { text: `waiting ${left.filter((id) => !due.includes(id)).join(" ")}`, color: t.dim },
    ].filter(Boolean);
    if (!parts.length) return null;
    return h_flex()
      .id("factory-team-reviews")
      .flex_none()
      .flex_wrap()
      .gap(8)
      .px(8)
      .py(4)
      .text_size(TEXT.small)
      .child(div().text_color(t.dim).child("Reviews"))
      .children(parts.map((p) => div().text_color(p.color).child(p.text)));
  },

  teamEmpty(body) {
    if (this.teamError) return body.child(Message(this.teamError, true));
    return body.child(
      Message(this.team() ? "No lane team here. A Lead's .tsf/plan.md and lanes show up here." : "Reading the team…"),
    );
  },

  teamView(root) {
    const t = theme();
    const team = this.team();
    const body = v_flex().id("factory-team").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    if (!team?.lanes.length && !team?.issues.length) return root.child(this.teamEmpty(body));
    body.child(this.teamHeader(team));
    body.child(this.laneSkillStrip(team));
    body.child(GroupHeader({ id: "factory-team-lanes-group", label: "Lanes", count: team.lanes.length, divided: true }));
    for (const lane of team.lanes) body.child(this.laneRow(team, lane));
    const reviews = this.reviewsLine(team);
    if (reviews) body.child(reviews);
    if (team.events.length) {
      body.child(GroupHeader({ id: "factory-team-events", label: "Latest", divided: true }));
      team.events.forEach((e, i) =>
        body.child(
          h_flex()
            .id(`factory-team-event-${i}`)
            .flex_none()
            .px(8)
            .py(3)
            .gap(8)
            .text_size(TEXT.small)
            .child(div().w(34).flex_none().text_color(t.dim).child(span(team.now - e.at)))
            .child(div().flex_1().min_w(0).truncate().text_color(e.kind === "review" && /defects/.test(e.text) ? t.blocked : t.muted).child(e.text)),
        ),
      );
    }
    if (this.teamError) body.child(Message(this.teamError, true));
    return root.child(body);
  },

  // Each flow stage with its sessions' chips; a stage opens to list its issues.
  laneFlow(body) {
    const t = theme();
    const team = this.team();
    if (!team?.lanes.length && !team?.issues.length) return false;
    const lead = this.lead(team);
    const chips = Object.fromEntries(FLOW.map((s) => [s, []]));
    chips[leadStage(team)].push({ label: "Lead", address: lead?.address, status: lead?.status });
    for (const lane of team.lanes) {
      const at = lane.stage === "landed" ? (lane.left.length ? "build" : "land") : ISSUE_AT[lane.stage];
      chips[at].push({ label: lane.builder ?? lane.id, address: lane.address, status: lane.flag === "STALL" ? "blocked" : lane.status });
    }
    const items = (stage) =>
      stage === "finish"
        ? team.milestones.done.map((m) => ({ id: m, detail: "closed" }))
        : team.issues.filter((i) => ISSUE_AT[i.stage] === stage).map((i) => ({ id: i.id, detail: `lane ${i.lane}${i.commit ? ` · ${i.commit}` : ""}` }));
    body.child(GroupHeader({ id: "factory-flow", label: "Lane flow" }));
    FLOW.forEach((stage, i) => {
      const list = items(stage);
      const open = this.flowOpen === stage;
      body.child(
        GroupHeader({
          id: `factory-flow-${stage}`,
          label: `${i + 1}  ${title(stage)}`,
          count: list.length || null,
          collapsed: !open,
          onClick: (cx) => {
            this.flowOpen = open ? null : stage;
            cx.notify();
          },
        }),
      );
      // Chips get their own wrapping line: a narrow panel can't fit several beside the stage name.
      if (chips[stage].length)
        body.child(
          h_flex()
            .flex_none()
            .flex_wrap()
            .gap(4)
            .pl(30)
            .pr(8)
            .pb(4)
            .children(
              chips[stage].map((c, j) =>
                h_flex()
                  .id(`factory-chip-${stage}-${j}`)
                  .gap(4)
                  .px(6)
                  .py(1)
                  .rounded(9)
                  .items_center()
                  .border_1()
                  .border_color(t.border)
                  .text_color(t.foreground)
                  .when(Boolean(c.address), (el) =>
                    el
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        peek(c.address);
                      }),
                  )
                  .child(StatusDot(c.status ?? "unknown", 6))
                  .child(c.label),
              ),
            ),
        );
      if (open)
        for (const item of list.length ? list : [{ id: "Nothing here now", detail: "" }])
          body.child(
            h_flex()
              .flex_none()
              .pl(30)
              .pr(8)
              .py(2)
              .gap(8)
              .text_size(TEXT.small)
              .child(div().text_color(list.length ? t.foreground : t.dim).child(item.id))
              .child(div().truncate().text_color(t.dim).child(item.detail)),
          );
    });
    return true;
  },
};
