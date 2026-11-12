// Skills: which skills each lane loads. The Skills tab edits the groups (one card each), and the Team tab's
// lane strip edits a lane's `skills <lane>:` plan line. Every edit runs orchestration's skills.mjs; after a
// lane edit the Lead is told, so it can tell that lane's builder.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { appHome, exec, theme } from "herdr";
import { addable, groupTokens, laneSummary, shortCount, tokensOf } from "../run/skills.js";
import { TEXT, Message, halfTone } from "./ui.js";

const SHOWN = 8; // matches listed at once in the add list; typing narrows it

export const skillMethods = {
  async skillsCli(args) {
    const r = await exec("node", ["--no-warnings", `${appHome()}/mods/orchestration/harness/skills/skills.mjs`, ...args]);
    if (r.code !== 0) throw new Error(r.stderr?.trim() || `skills.mjs ${args[0]} failed`);
    return r.stdout;
  },

  // The installed list only changes when a skill is installed, so it's read with the map on first show and on refresh.
  loadSkills(cx, all = false) {
    cx.spawn(async (cx) => {
      try {
        this.skillMap = JSON.parse(await this.skillsCli(["groups"]));
        if (all || !this.skillsInstalled) this.skillsInstalled = JSON.parse(await this.skillsCli(["installed"]));
        this.skillsError = null;
      } catch (e) {
        this.skillsError = e.message;
      }
      cx.notify();
    });
  },

  openPicker(key, cx) {
    this.skillPicker = this.skillPicker === key ? null : key;
    this.skillQuery.set_value("");
    if (this.skillPicker) this.skillQuery.focus();
    cx.notify();
  },

  editGroup(op, group, skill, cx) {
    this.skillPicker = null;
    cx.spawn(async (cx) => {
      try {
        await this.skillsCli([op, group, skill]);
      } catch (e) {
        this.skillsError = e.message;
      }
      this.loadSkills(cx);
    });
  },

  // The plan line changes first; the Lead hears of it after, so a failed send never loses the edit.
  editLane(team, lane, op, token, cx) {
    this.skillPicker = null;
    cx.spawn(async (cx) => {
      try {
        const line = (await this.skillsCli(["lane", team.project, lane, op, token])).trim();
        const lead = this.lead(team)?.address;
        if (!lead) throw new Error(`Saved "${line}", but no Lead was found to tell.`);
        const sent = await exec("hc", ["send", lead, `skills changed for lane ${lane}: ${line}`]);
        if (sent.code !== 0) throw new Error(`Saved "${line}", but telling the Lead failed: ${sent.stderr?.trim()}`);
        this.skillsError = null;
      } catch (e) {
        this.skillsError = e.message;
      }
      this.loadTeam(cx);
      cx.notify();
    });
  },

  skillChip({ id, label, tooltip, missing = false, onRemove }) {
    const t = theme();
    return h_flex()
      .id(id)
      .flex_none()
      .h(22)
      .pl(8)
      .pr(onRemove ? 3 : 8)
      .gap(2)
      .items_center()
      .rounded_full()
      .bg(t.hover)
      .text_size(TEXT.small)
      .text_color(missing ? t.dim : t.foreground)
      .tooltip(tooltip)
      .child(div().child(label))
      .when(Boolean(onRemove), (el) =>
        el.child(
          div()
            .id(`${id}-rm`)
            .size(16)
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.bg(t.selected).text_color(t.foreground))
            .tooltip(`Remove ${label}`)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              onRemove(cx);
            })
            .child("×"),
        ),
      );
  },

  addChip(id, key) {
    const t = theme();
    const open = this.skillPicker === key;
    return div()
      .id(id)
      .flex_none()
      .h(22)
      .px(8)
      .flex()
      .items_center()
      .rounded_full()
      .border_1()
      .border_color(open ? t.accent : t.border)
      .text_size(TEXT.small)
      .text_color(open ? t.foreground : t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.openPicker(key, cx))
      .child(open ? "Done" : "+ Add");
  },

  // A search box over the choices, the first few matches below it.
  picker(key, choices, onPick) {
    const t = theme();
    const found = choices.filter((c) => addable([`${c.id} ${c.label ?? ""}`], [], this.skillQuery.value()).length);
    return v_flex()
      .id(`${key}-picker`)
      .flex_none()
      .gap(2)
      .pt(6)
      .child(div().h(28).child(Input.new(this.skillQuery)))
      .children(
        found.slice(0, SHOWN).map((c) =>
          h_flex()
            .id(`${key}-pick-${c.id}`)
            .flex_none()
            .h(26)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .text_size(TEXT.small)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onPick(c.id, cx))
            .child(div().flex_1().min_w(0).truncate().child(c.label ?? c.id))
            .child(div().flex_none().text_color(t.dim).child(c.detail ?? "")),
        ),
      )
      .when(found.length > SHOWN, (el) =>
        el.child(div().px(8).text_size(TEXT.caption).text_color(t.dim).child(`${found.length - SHOWN} more: keep typing`)),
      )
      .when(!found.length, (el) => el.child(div().px(8).text_size(TEXT.caption).text_color(t.dim).child("Nothing matches")));
  },

  skillTip(name) {
    const s = this.skillsInstalled?.find((x) => x.name === name);
    return s ? `${(s.bytes / 1024).toFixed(1)} KB · ~${shortCount(tokensOf(s.bytes))} tokens` : "Not installed";
  },

  groupCard(group) {
    const t = theme();
    const key = `group:${group.id}`;
    const installed = this.skillsInstalled ?? [];
    const names = new Set(installed.map((s) => s.name));
    return v_flex()
      .id(`factory-skills-${group.id}`)
      .flex_none()
      .min_w(0)
      .p(12)
      .gap(6)
      .rounded(12)
      .bg(halfTone(t.raised))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().child(group.title || group.id))
          .child(
            div()
              .id(`factory-skills-${group.id}-weight`)
              .flex_none()
              .text_size(TEXT.small)
              .text_color(t.dim)
              .tooltip("SKILL.md bytes / 4, for every skill in this group")
              .child(`~${shortCount(groupTokens(group, installed))} tokens`),
          ),
      )
      // The Lead writes `always` into each plan's structure:/prose: rules; no lane loads it as skills.
      .when(group.id === "always" || Boolean(group.when), (el) =>
        el.child(
          div()
            .text_size(TEXT.small)
            .text_color(t.muted)
            .child(group.id === "always" ? "Distilled into every plan" : `When: ${group.when}`),
        ),
      )
      .child(
        h_flex()
          .flex_wrap()
          .gap(4)
          .pt(2)
          .children(
            group.skills.map((name) =>
              this.skillChip({
                id: `factory-skill-${group.id}-${name}`,
                label: name,
                tooltip: this.skillTip(name),
                missing: !names.has(name),
                onRemove: (cx) => this.editGroup("rm", group.id, name, cx),
              }),
            ),
          )
          .child(this.addChip(`factory-skills-${group.id}-add`, key)),
      )
      .when(this.skillPicker === key, (el) =>
        el.child(
          this.picker(
            key,
            installed.filter((s) => !group.skills.includes(s.name)).map((s) => ({ id: s.name, detail: `~${shortCount(tokensOf(s.bytes))}` })),
            (name, cx) => this.editGroup("add", group.id, name, cx),
          ),
        ),
      );
  },

  skillsView(root) {
    const body = v_flex().id("factory-skills").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8);
    if (this.skillsError) body.child(Message(this.skillsError, true));
    if (!this.skillMap) return root.child(body.child(Message("Reading skills…")));
    for (const group of this.skillMap.groups) body.child(this.groupCard(group));
    return root.child(body);
  },

  // Team tab: one quiet line per lane; a click opens its plan line's groups and skills as chips.
  laneSkillStrip(team) {
    const t = theme();
    const groups = this.skillMap?.groups ?? [];
    const strip = v_flex().id("factory-lane-skills").flex_none().px(8).pb(6).gap(2);
    if (this.skillsError) strip.child(Message(this.skillsError, true));
    for (const lane of team.lanes) {
      const key = `lane:${lane.id}`;
      const open = this.skillPicker === key || this.laneSkillsOpen === lane.id;
      const tokens = lane.skills ?? [];
      strip.child(
        h_flex()
          .id(`factory-lane-skills-${lane.id}`)
          .flex_none()
          .h(22)
          .gap(8)
          .min_w(0)
          .items_center()
          .rounded(6)
          .text_size(TEXT.small)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(`skills ${lane.id}: ${tokens.join(" ") || "(none)"}`)
          .on_click((_e, cx) => {
            this.laneSkillsOpen = this.laneSkillsOpen === lane.id ? null : lane.id;
            if (this.skillPicker?.startsWith("lane:")) this.skillPicker = null;
            cx.notify();
          })
          .child(div().w(56).flex_none().truncate().text_color(t.muted).child(lane.id))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(laneSummary(tokens, groups) || "no skills")),
      );
      if (!open) continue;
      const byId = new Map(groups.map((g) => [g.id, g]));
      strip.child(
        h_flex()
          .flex_wrap()
          .gap(4)
          .pl(64)
          .py(4)
          .children(
            tokens.map((tok) =>
              this.skillChip({
                id: `factory-lane-${lane.id}-${tok}`,
                label: byId.has(tok) ? byId.get(tok).title || tok : `+${tok}`,
                tooltip: byId.has(tok) ? `Group: ${byId.get(tok).skills.join(", ")}` : this.skillTip(tok),
                onRemove: (cx) => this.editLane(team, lane.id, "rm", tok, cx),
              }),
            ),
          )
          .child(this.addChip(`factory-lane-${lane.id}-add`, key)),
      );
      if (this.skillPicker === key)
        strip.child(
          div()
            .pl(64)
            .child(
              this.picker(
                key,
                [
                  ...groups.filter((g) => g.id !== "always" && !tokens.includes(g.id)).map((g) => ({ id: g.id, label: g.title || g.id, detail: "group" })),
                  ...(this.skillsInstalled ?? []).filter((s) => !tokens.includes(s.name)).map((s) => ({ id: s.name, detail: `~${shortCount(tokensOf(s.bytes))}` })),
                ],
                (tok, cx) => this.editLane(team, lane.id, "add", tok, cx),
              ),
            ),
        );
    }
    return strip;
  },
};
