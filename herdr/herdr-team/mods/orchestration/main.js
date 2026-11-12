// The Orchestrate view's parts, picked by props: `terminal` draws one session's header,
// view "chain" the top bar (it also watches for sends), "spine" the line messages travel
// along between sessions, "map" the Team view, "drop" the squares shown during a drag,
// "panel-head" the right panel's title bar.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, exec, focused, layout, nextCommand, panes, props, run, setShared, shared, spaces, terminals, theme } from "herdr";
import { latestActivity } from "./activity.js";
import { placed, zoneCount } from "./drop.js";
import { detect, hcMessages } from "./events.js";
import { SCAN, elapsed, parseSubagents } from "./subagents.js";
import { CREW, STATIONS, WRITE_TEMPLATE, launchArgs, staffing, templateOf, templateText } from "./team.js";
import { COLUMNS, inColumn, parseTickets } from "./tickets.js";

const POLL_MS = 1200;
const SYNC_MS = 60000; // GitHub issues change slowly, and each check is a network call
const syncedAt = {};
const owns = (s, owner) => s.id === owner?.toLowerCase() || s.title.toLowerCase() === owner?.toLowerCase();
const SCAN_EVERY = 3;
const FRAME_MS = 33;
const FLIGHT_MS = 1200;
const LINGER_MS = 300;
const FRESH_MS = 2500; // how long a new message stays highlighted
const MAX_FLYING = 8;
const MAX_LOG = 60;
const MAX_CARDS = 12;
const TICKET_FRESH_S = 4;
const LABEL_CHARS = 34;
const START_GUARD_MS = 15000;
const DRAG_PX = 6;
const SPINE_DOTS = 22;
const HEADER_MIDDLE = 17; // px from the top of a session to the middle of its header
const MONO = "JetBrains Mono";
const PLANES = "orch-planes";
const MAP = "orch-map";
const PANEL_NAMES = { files: "Files", changes: "Changes", "herdr-sim": "Simulator", "herdr-web": "Web",
  git: "Git", agenttrail: "Agenttrail", blueprint: "Blueprint", factory: "Factory", ops: "Ops" };

// A ticket's trace file, `<project>/.tsf/traces/<ticket>.json`: one summary line, cost, transcript path.
export function parseTrace(text) {
  try {
    const j = JSON.parse(text);
    const last = (v) => Array.isArray(v) ? v.at(-1) : v;
    const line = last(j.summary ?? j.summaries);
    return { summary: typeof line === "string" ? line : line?.text ?? "", cost: Number(j.cost ?? j.dollars) || 0, transcript: j.transcript ?? "" };
  } catch { return null; }
}

// What the trace reader printed: one `<ticket>\t<json>` line per file.
export function parseTraces(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("\t");
    const trace = i > 0 ? parseTrace(line.slice(i + 1)) : null;
    if (trace) out[line.slice(0, i)] = trace;
  }
  return out;
}

const READ_TRACES = 'cd "$1" 2>/dev/null || exit 0; for f in .tsf/traces/*.json; do [ -f "$f" ] && { printf "%s\\t" "$(basename "$f" .json)"; tr -d "\\n" < "$f"; echo; }; done; exit 0';
const WRITE_STATE = 'mkdir -p "$HOME/.config/herdr-app" && printf "%s\\n" "$1" > "$HOME/.config/herdr-app/orch-state.json"';

// Mod commands arrive as text: "start-team", "view:sessions", "place:<terminal>:<slot>", "state".
export function parseCommand(text) {
  const [name, ...args] = String(text).split(":");
  return { name, args };
}

const find = (node, id) => node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null);
const currentSpace = () => spaces().find((p) => p.active);
const activeSpace = () => currentSpace()?.id;
const columnsShown = () => (find(layout(), PLANES)?.children ?? []).filter((c) => c.type === "column").map((c) => c.children.map((cell) => cell.id.slice("cell-".length)));

// The sessions on screen, across then down.
function shownOrder() {
  const columns = columnsShown();
  const rows = columns.length ? Math.max(...columns.map((c) => c.length)) : 0;
  return Array.from({ length: rows }, (_, r) => columns.flatMap((c) => c[r] ?? [])).flat();
}

const whereShown = (address) => {
  const columns = columnsShown();
  const col = columns.findIndex((c) => c.includes(address));
  return col < 0 ? null : { col, row: columns[col].indexOf(address), rows: columns[col].length, columns: columns.length };
};

const helperAddresses = () => new Set(terminals().filter((k) => k.parent).map((k) => k.address));
const labelMap = () => new Map(terminals().map((k) => [k.address, k.labels]));
const spaceAgents = () => agents().filter((a) => a.space === activeSpace());
const currentStaff = () => staffing(spaceAgents(), labelMap(), helperAddresses());

// Where the team already works, so "Start N more" joins it; else where the person is.
const teamFolder = (staff) => panes().find((p) => p.pane === Object.values(staff)[0]?.pane)?.cwd ?? focused()?.cwd;

const icon = (p, color, size = 15) => {
  if (!p?.icon) return div().size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
};
const statusDot = (a, t, size = 7) => {
  const dot = div().size(size).flex_none().rounded_full().bg(t[a.status] ?? t.dim);
  return a.status === "working" ? dot.loop("opacity", { from: 0.35, to: 1, period: 1200 }) : dot;
};
const progress = (p) => Math.min(1, (Date.now() - p.at) / FLIGHT_MS);
const smooth = (f) => f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f);
// A message leaves along the sender's header, runs down the spine, then enters along the receiver's.
const leg = (p, from, to) => {
  const f = progress(p);
  return f >= from && f < to ? (f - from) / (to - from) : null;
};

function roleOf(a, labels) {
  const own = labels?.get(a.address);
  return own?.role || STATIONS.find((s) => s.title === a.tab_name)?.title || own?.task || a.title || "";
}

// A station's title, or whatever best names any other session.
function nameOf(key, staff, labels) {
  if (key === "you") return "You";
  const station = STATIONS.find((s) => staff[s.id]?.address === key);
  if (station) return station.title;
  const a = agents().find((x) => x.address === key);
  return (a && roleOf(a, labels)) || key;
}

// Each space keeps its own view and sessions; the tab bar mod applies them to the layout.
function updateSpace(patch) {
  const space = activeSpace();
  const all = shared("orch.spaces") ?? {};
  if (space) setShared("orch.spaces", { ...all, [space]: { ...all[space], ...patch } });
}

const logHere = () => (shared("orch.log") ?? []).filter((e) => e.space === activeSpace());

export default class Orchestration extends View {
  init(_props, cx) {
    if (props()?.view !== "chain") return;
    this.nextPacket = 0;
    this.nextLog = Date.now(); // the log outlives this copy, so ids can't restart at 0
    setShared("orch.packets", []); // a previous copy's timers died with it, mid-flight
    let previous = null;
    let subagents = [];
    cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand()); cx.notify(); } });
    cx.spawn(async (cx) => {
      for (let tick = 0; ; tick++) {
        if (tick % SCAN_EVERY === 0) {
          const scan = await exec("sh", ["-c", SCAN]).catch(() => null);
          if (scan) subagents = parseSubagents(scan.stdout, Date.now() / 1000).filter((s) => s.running);
        }
        const staff = currentStaff();
        const watched = new Set([...shownOrder(), ...STATIONS.map((s) => staff[s.id]?.address).filter(Boolean)]);
        const list = agents().filter((a) => watched.has(a.address));
        const latest = {};
        const messages = {};
        await Promise.all(list.map(async (a) => {
          // shortcut: hc's usual install path, change it if hc moves
          const read = await exec("sh", ["-c", 'exec "$HOME/.local/bin/hc" read "$1"', "sh", a.address]).catch(() => null);
          if (read?.code !== 0) return;
          latest[a.address] = latestActivity(read.stdout) ?? a.title ?? "";
          messages[a.address] = hcMessages(read.stdout);
        }));
        // Every session in the space counts as a sender, even one off screen.
        const now = { statuses: Object.fromEntries(spaceAgents().map((a) => [a.address, a.status])), messages, subagents };
        this.launch(detect(previous, now), cx);
        previous = now;
        // Setting shared state redraws every mod, so only when something changed.
        const ordered = Object.fromEntries(Object.entries(latest).sort()); // reads finish in any order
        if (JSON.stringify(ordered) !== JSON.stringify(shared("orch.latest"))) setShared("orch.latest", ordered);
        // Team first in the grid; only a staffed station shows its sub-sessions, so the grid keeps everyone else's.
        const staffed = STATIONS.map((s) => staff[s.id]?.address).filter(Boolean);
        if (staffed.join() !== (shared("orch.staffed") ?? []).join()) setShared("orch.staffed", staffed);
        if (JSON.stringify(subagents) !== JSON.stringify(shared("orch.subagents"))) setShared("orch.subagents", subagents);
        const here = currentSpace();
        if (here && Object.keys(staff).length && Date.now() - (syncedAt[here.id] ?? 0) > SYNC_MS) { // only a started team links its folder's repo
          syncedAt[here.id] = Date.now();
          exec("sh", ["-c", 'cd "$2" && exec sh "$HOME/.config/herdr-app/mods/orchestration/harness/tickets/ticket.sh" "$1" sync', "sh", here.id, teamFolder(staff) ?? "."]).catch(() => {});
        }
        const board = await exec("sh", ["-c", 'exec sh "$HOME/.config/herdr-app/mods/orchestration/harness/tickets/ticket.sh" "$1" ls', "sh", here?.id ?? ""]).catch(() => null);
        const published = shared("orch.tickets");
        if (board?.code === 0 && (published?.space !== here?.id || published?.text !== board.stdout)) setShared("orch.tickets", { space: here?.id, text: board.stdout });
        const folder = here && teamFolder(staff);
        const traces = folder ? await exec("sh", ["-c", READ_TRACES, "sh", folder]).catch(() => null) : null;
        const found = traces?.code === 0 ? parseTraces(traces.stdout) : {};
        if (JSON.stringify(found) !== JSON.stringify(shared("orch.traces"))) setShared("orch.traces", found);
        await new Promise((resolve) => cx.timer.after(POLL_MS, () => resolve()));
      }
    });
  }

  // Every button has a command that runs the same code; `state` publishes what is shown and placed.
  command(text) {
    const { name, args } = parseCommand(text);
    if (name === "start-team") this.startTeam();
    else if (name === "view" && ["sessions", "tickets"].includes(args[0])) updateSpace({ on: true, view: args[0] === "tickets" ? MAP : PLANES });
    else if (name === "place" && args[0] && /^\d+$/.test(args[1] ?? "")) updateSpace({ on: true, view: PLANES, slots: placed(shownOrder(), args[0], Number(args[1])) });
    else if (name !== "state") return;
    this.publishState();
  }

  publishState() {
    const space = currentSpace();
    const view = (shared("orch.spaces") ?? {})[space?.id]?.view;
    const state = { space: space?.id, view: view === MAP ? "tickets" : "sessions", placed: shownOrder(), columns: columnsShown() };
    setShared("orch.state", state);
    exec("sh", ["-c", WRITE_STATE, "sh", JSON.stringify(state)]).catch(() => {});
  }

  launch(events, cx) {
    if (events.length) {
      const stamp = new Date();
      const space = activeSpace();
      const entries = events.map((e) => ({ ...e, space, time: stamp.toTimeString().slice(0, 5), at: stamp.getTime(), id: this.nextLog++ })).reverse();
      setShared("orch.log", [...entries, ...(shared("orch.log") ?? [])].slice(0, MAX_LOG));
    }
    const flying = shared("orch.packets") ?? [];
    const fresh = events.slice(0, Math.max(0, MAX_FLYING - flying.length)).map((e) => ({ ...e, id: this.nextPacket++, at: Date.now() }));
    if (!fresh.length) return;
    const ids = new Set(fresh.map((p) => p.id));
    setShared("orch.packets", [...flying, ...fresh]);
    cx.timer.after(FLIGHT_MS + LINGER_MS, () => setShared("orch.packets", (shared("orch.packets") ?? []).filter((p) => !ids.has(p.id))));
    if (this.stepping) return;
    this.stepping = true;
    this.step(cx);
  }

  // Stepped here because native motion takes pixels and these are laid out in %. Runs only during a flight.
  step(cx) {
    if (!(shared("orch.packets") ?? []).length) {
      this.stepping = false;
      return;
    }
    setShared("orch.frame", Date.now());
    cx.timer.after(FRAME_MS, (cx) => this.step(cx));
  }

  startTeam() {
    const space = currentSpace();
    const staff = currentStaff();
    const folder = teamFolder(staff) ?? space?.folder; // once, so the whole team shares one working folder
    this.started ??= new Map();
    updateSpace({ slots: undefined }); // what was placed by hand would keep the new team off screen
    for (const s of [...STATIONS, ...CREW]) exec("sh", ["-c", WRITE_TEMPLATE, "sh", templateOf(s), templateText(s)]).catch(() => {});
    for (const s of STATIONS.filter((x) => !x.onDemand)) {
      // A new agent takes a moment to appear, so a second click would start another.
      const key = `${space?.id}/${s.id}`;
      if (staff[s.id] || Date.now() - (this.started.get(key) ?? 0) < START_GUARD_MS) continue;
      this.started.set(key, Date.now());
      run("tab.new", { name: s.title, space: space?.id, folder, argv: launchArgs(s, space) });
    }
  }

  // Only a press that moves is a drag, so clicks stay clicks.
  dragSource(el, address) {
    return el.on_mouse_down("left", (e) => { this.press = { address, x: e.position.x, y: e.position.y }; })
      .on_mouse_move((e) => {
        if (this.press?.address !== address || Math.hypot(e.position.x - this.press.x, e.position.y - this.press.y) < DRAG_PX) return;
        this.press = null;
        setShared("orch.drag", address);
      })
      .on_mouse_up("left", () => { this.press = null; })
      // A release off this element never reaches it, so a press that wandered off must not stay armed.
      .on_hover((on) => { if (!on && this.press?.address === address) this.press = null; });
  }

  header(t, address) {
    const a = agents().find((x) => x.address === address);
    const place = whereShown(address);
    if (!a || !place) return div();
    const staff = currentStaff();
    const labels = labelMap();
    const packets = shared("orch.packets") ?? [];
    const leaving = packets.find((p) => p.from === address && p.to !== address && !p.subagent);
    const arriving = packets.find((p) => p.to === address && !p.subagent);
    const spineOnRight = place.columns === 2 && place.col === 0;
    const out = leaving ? leg(leaving, 0, 1 / 3) : null;
    const entering = arriving ? leg(arriving, 2 / 3, 1) : null;
    const line = out !== null ? (spineOnRight ? out : 1 - out) : entering !== null ? (spineOnRight ? 1 - entering : entering) : null;
    const note = arriving ? `← ${nameOf(arriving.from, staff, labels)}  ${arriving.text}` : leaving ? `→ ${nameOf(leaving.to, staff, labels)}  ${leaving.text}` : "";
    const canRemove = shownOrder().length > 1;
    return this.dragSource(h_flex().id(`bar-${address}`).relative().size_full().overflow_hidden().px(12).gap(7).items_center().border_b(1).border_color(t.border).cursor_pointer()
      .when(line !== null, (el) => el.bg(t.accent + "26")).on_click(() => run("pane.focus", { terminal: address })), address)
      .child(icon(a.program, t.foreground))
      .child(div().flex_none().text_size(13).text_color(t.foreground).child(nameOf(address, staff, labels) || a.program?.name || "Agent"))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(t.dim).child(address))
      .when(Boolean(note), (el) => el.child(div().flex_none().max_w(260).truncate().font_family(MONO).text_size(11).text_color(t.accent).child(note.slice(0, LABEL_CHARS))))
      .child(statusDot(a, t))
      .when(canRemove, (el) => el.child(div().id(`hide-${address}`).flex_none().size(18).flex().items_center().justify_center().rounded(5).cursor_pointer().text_size(10).text_color(t.dim)
        .hover((s) => s.bg(t.foreground + "1a").text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const rest = shownOrder().filter((x) => x !== address);
          if (focused()?.terminal === address) run("pane.focus", { terminal: rest[0] }); // or the keyboard stays with a session that's gone from view
          updateSpace({ slots: rest });
        }).child("✕")))
      .when(line !== null, (el) => el.child(div().absolute().bottom(0).h(2).w(90).ml(-45).rounded_full().bg(t.accent).left(`${line * 100}%`)));
  }

  // The rail between the sessions. Messages run along it from one header's height to another's.
  spine(t) {
    const heightOf = (key) => {
      if (key === "you") return -4; // comes in from the top bar
      const place = whereShown(key);
      return place ? (place.row / place.rows) * 100 : null;
    };
    const packets = (shared("orch.packets") ?? []).filter((p) => !p.subagent && heightOf(p.from) !== null && heightOf(p.to) !== null);
    const stops = columnsShown().flat().map((address) => heightOf(address));
    return div().id("spine").relative().size_full().overflow_hidden()
      .children(Array.from({ length: SPINE_DOTS }, (_, i) => div().absolute().size(2).rounded_full().bg(t.accent).opacity(0.3).left("50%").ml(-1).top(`${(i / SPINE_DOTS) * 100}%`)))
      .children(stops.map((y) => div().absolute().size(6).rounded_full().bg(t.accent).opacity(0.6).left("50%").ml(-3).top(`${y}%`).mt(HEADER_MIDDLE - 3)))
      .children(packets.flatMap((p) => {
        const along = leg(p, 1 / 3, 2 / 3);
        if (along === null) return [];
        const y = heightOf(p.from) + (heightOf(p.to) - heightOf(p.from)) * smooth(along);
        return [
          div().id(`halo-${p.id}`).absolute().size(16).rounded_full().bg(t.accent + "40").left("50%").ml(-8).top(`${y}%`).mt(HEADER_MIDDLE - 8),
          div().id(`dot-${p.id}`).absolute().size(8).rounded_full().bg(t.accent).left("50%").ml(-4).top(`${y}%`).mt(HEADER_MIDDLE - 4),
        ];
      }));
  }

  chain(t) {
    const active = find(layout(), "orch-body")?.active ?? PLANES;
    const staff = currentStaff();
    const labels = labelMap();
    const always = STATIONS.filter((s) => !s.onDemand);
    const missing = always.filter((s) => !staff[s.id]).length;
    const last = logHere()[0];
    const fresh = last && Date.now() - last.at < FRESH_MS;
    const button = (id, label, on, click) => div().id(id).flex_none().px(10).h(24).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.foreground + "24" : t.foreground + "00").text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.foreground + "1a")).on_click(click).child(label);
    const tab = (child, label) => button(`view-${child}`, label, active === child, () => updateSpace({ view: child }));
    return h_flex().id("chain").size_full().px(12).gap(10).items_center()
      .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(currentSpace()?.name ?? ""))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11.5).text_color(fresh ? t.accent : t.dim)
        .child(last && !last.subagent ? `${nameOf(last.from, staff, labels)} → ${nameOf(last.to, staff, labels)}  ${last.text}` : ""))
      .child(h_flex().flex_none().gap(2).p(2).rounded(8).border(1).border_color(t.foreground + "1a").child(tab(PLANES, "Sessions")).child(tab(MAP, "Tickets")))
      .when(missing > 0, (el) => el.child(div().id("start-team").flex_none().px(10).h(24).flex().items_center().rounded(6).cursor_pointer().bg(t.accent).text_size(12).text_color(t.accent_foreground)
        .on_click(() => this.startTeam()).child(missing === always.length ? "Start team" : `Start ${missing} more`)))
      .child(button("orch-exit", "Exit  ⌘⇧O", false, () => updateSpace({ on: false })));
  }

  // Full-size squares in place of the terminals while something is dragged.
  dropZones(t) {
    const address = shared("orch.drag");
    if (!address) return div();
    const staff = currentStaff();
    const labels = labelMap();
    const shown = shownOrder();
    const count = zoneCount(shown, address);
    const columns = (shared("orch.fits") ?? [])[count - 1] ?? 1; // the same shape the grid will take
    const name = nameOf(address, staff, labels);
    const zone = (i) => {
      const current = shown[i];
      const title = current === address ? "Keep here" : current ? nameOf(current, staff, labels) : "New square";
      const action = current === address ? "" : !current ? `Add ${name}` : shown.includes(address) ? "Swap places" : `Replace with ${name}`;
      return v_flex().id(`zone-${i}`).flex_1().min_h(0).items_center().justify_center().gap(4).rounded(12).border(1).cursor_pointer()
        .border_color(t.accent + "59").bg(t.accent + "12").hover((s) => s.bg(t.accent + "40").border_color(t.accent))
        .on_mouse_up("left", () => {
          const slots = placed(shown, address, i);
          setShared("orch.drag", null);
          updateSpace({ on: true, view: PLANES, slots });
        })
        .child(div().text_size(15).text_color(t.foreground).child(title))
        .when(Boolean(action), (el) => el.child(div().text_size(12).text_color(t.muted).child(action)));
    };
    const cancel = () => setShared("orch.drag", null);
    return v_flex().id("drop").size_full().gap(8).on_mouse_up("left", cancel)
      .child(h_flex().flex_1().min_h(0).gap(8).children(Array.from({ length: columns }, (_, c) => v_flex().flex_1().min_w(0).h_full().gap(8)
        .children(Array.from({ length: count }, (_, i) => i).filter((i) => i % columns === c).map(zone)))))
      .child(h_flex().flex_none().h(26).gap(10).items_center().justify_center()
        .child(div().text_size(12).text_color(t.muted).child(`Placing ${name}`))
        .child(div().id("drop-cancel").px(10).h(22).flex().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.foreground).bg(t.foreground + "14")
          .hover((s) => s.bg(t.foreground + "24")).on_click(cancel).child("Cancel")));
  }

  panelHead(t) {
    const active = find(layout(), "panel-body")?.active;
    const ids = find(layout(), "panel-body")?.children?.map((c) => c.id) ?? [];
    // Panels that share a top-bar button (tabs-herdr-sim GROUPS) get a switch instead of a title.
    const group = [[["herdr-sim", "Simulator"], ["herdr-web", "Web"]], [["git", "Git"], ["agenttrail", "Trail"], ["blueprint", "Blueprint"]], [["ops", "Ops"], ["factory", "Workflows"]]]
      .map((g) => g.filter(([id]) => ids.includes(id))).find((g) => g.some(([id]) => id === active));
    const segment = (id, label) => div().id(`preview-${id}`).h(22).px(10).flex().items_center().rounded_full().text_size(12)
      .text_color(active === id ? t.foreground : t.muted).when(active === id, (el) => el.bg(t.foreground + "24").font_semibold())
      .hover((s) => s.text_color(t.foreground)).on_click(() => run("layout.select", { stack: "panel-body", child: id })).child(label);
    return h_flex().id("panel-head").size_full().px(12).items_center().border_b(1).border_color(t.border)
      .child(group
        ? h_flex().flex_1().child(h_flex().p(2).gap(2).rounded_full().bg(t.foreground + "0f").border(1).border_color(t.border)
          .children(group.map(([id, label]) => segment(id, label))))
        : div().flex_1().text_size(12.5).text_color(t.foreground).child(PANEL_NAMES[active] ?? "Panel"))
      .child(div().id("panel-close").size(22).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.foreground + "1a").text_color(t.foreground)).on_click(() => run("layout.hide", { id: "panel" }))
        .child(svg("mods/pane/close.svg").size(12)));
  }

  // One teammate: who, doing what, and whether a message just reached them.
  member(t, s, staff, tickets) {
    const a = staff[s.id];
    const held = tickets.filter((x) => owns(s, x.owner) && !COLUMNS[0].stages.includes(x.stage) && x.stage !== "done").map((x) => x.id);
    const receiving = (shared("orch.packets") ?? []).some((p) => a && p.to === a.address && !p.subagent);
    const chip = v_flex().id(`member-${s.id}`).flex_1().min_w(0).h(50).px(10).gap(2).justify_center().rounded(9).border(1)
      .bg(receiving ? t.accent + "24" : t.foreground + "08").border_color(receiving ? t.accent : t.foreground + "14")
      .child(h_flex().gap(6).items_center()
        .child(a ? statusDot(a, t) : div().size(7).flex_none().rounded_full().border(1).border_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(a ? t.foreground : t.muted).child(s.title))
        .when(held.length > 0, (el) => el.child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.accent).child(held.join(" ")))))
      .child(div().truncate().text_size(11).text_color(t.dim).child(a ? (shared("orch.latest") ?? {})[a.address] || a.title || "Waiting for work" : "Not started"));
    if (!a) return chip;
    return this.dragSource(chip.cursor_pointer().hover((e) => e.bg(t.foreground + "14")).on_click(() => {
      updateSpace({ view: PLANES });
      run("pane.focus", { terminal: a.address });
    }), a.address);
  }

  card(t, x, staff, nowS) {
    const station = STATIONS.find((s) => owns(s, x.owner));
    const a = station ? staff[station.id] : spaceAgents().find((g) => g.address === x.owner); // a worker's owner is its address
    const trace = (shared("orch.traces") ?? {})[x.id];
    const blocked = x.stage === "blocked";
    const fresh = nowS - x.at < TICKET_FRESH_S;
    const body = v_flex().id(`ticket-${x.id}`).flex_none().p(10).gap(7).rounded(9).border(1)
      .bg(fresh ? t.accent + "1f" : t.foreground + "0c").border_color(blocked ? t.blocked : fresh ? t.accent : t.foreground + "14")
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().font_family(MONO).text_size(10.5).text_color(t.dim).child(x.id))
        .when(blocked, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child("Blocked"))))
      .child(div().text_size(12.5).line_height(1.4).text_color(x.stage === "done" ? t.muted : t.foreground).child(x.title))
      .child(h_flex().gap(6).items_center()
        .when(Boolean(a), (el) => el.child(statusDot(a, t, 6)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(station?.title || (a ? `Worker ${x.owner}` : x.owner) || "Unassigned"))
        .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(elapsed(nowS - x.at))))
      .when(Boolean(trace), (el) => el
        .when(Boolean(trace.summary), (e) => e.child(div().text_size(11).line_height(1.35).text_color(t.muted).child(trace.summary)))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(`$${trace.cost.toFixed(2)}`))
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(trace.transcript))));
    return a ? body.cursor_pointer().hover((e) => e.bg(t.foreground + "16")).on_click(() => {
      updateSpace({ view: PLANES });
      run("pane.focus", { terminal: a.address });
    }) : body;
  }

  // The team along the top; every piece of work below it, by how far along it is.
  team(t) {
    const staff = currentStaff();
    const nowS = Date.now() / 1000;
    const published = shared("orch.tickets");
    const tickets = published?.space === activeSpace() ? parseTickets(published.text) : [];
    const column = (c) => {
      const cards = inColumn(tickets, c);
      return v_flex().id(`col-${c.title}`).flex_1().min_w(0).h_full().overflow_hidden().rounded(12).border(1).border_color(t.foreground + "14").bg(t.foreground + "06").p(6).gap(6)
        .child(h_flex().flex_none().h(24).px(6).items_center().justify_between()
          .child(div().text_size(12).text_color(t.muted).child(c.title))
          .child(div().font_family(MONO).text_size(11).text_color(t.dim).child(String(cards.length))))
        .children(cards.slice(0, MAX_CARDS).map((x) => this.card(t, x, staff, nowS)));
    };
    return v_flex().id("team").size_full().gap(8)
      .child(h_flex().flex_none().gap(6).children(STATIONS.map((s) => this.member(t, s, staff, tickets))))
      .when(tickets.length === 0, (el) => el.child(div().flex_none().px(4).text_size(12.5).text_color(t.dim).child("No tickets yet. Give the Lead a task and it will open them here.")))
      .child(h_flex().flex_1().min_h(0).gap(8).children(COLUMNS.map(column)));
  }

  render() {
    const t = theme();
    const p = props();
    if (p?.view === "chain") return this.chain(t);
    if (p?.view === "spine") return this.spine(t);
    if (p?.view === "map") return this.team(t);
    if (p?.view === "drop") return this.dropZones(t);
    if (p?.view === "panel-head") return this.panelHead(t);
    return p?.terminal ? this.header(t, p.terminal) : div();
  }
}
