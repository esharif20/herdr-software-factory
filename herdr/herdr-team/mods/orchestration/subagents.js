// Claude Code's subagents run inside its own process, so Herdr can't see them.
// shortcut: reads Claude Code's undocumented session files; if their format
// changes the subagents disappear from the list and this needs updating.
const RUNNING_MAX_S = 600; // no activity for this long means it died without finishing
const DONE_KEEP_S = 300;

export const SCAN = `find "$HOME/.claude/projects" -maxdepth 4 -path '*/subagents/agent-*.jsonl' -mmin -15 2>/dev/null | while IFS= read -r f; do
  m="\${f%.jsonl}.meta.json"
  [ -f "$m" ] || continue
  s="\${f%/subagents/*}"
  printf '%s\\t%s\\t%s\\t%s\\n' "$(stat -f %m "$f")" "$(stat -f %B "$f")" "\${s##*/}" "$(tr -d '\\n' < "$m")"
done
# Which Herdr terminal each running Claude session is in, from its environment.
for s in "$HOME"/.claude/sessions/*.json; do
  p="\${s##*/}"
  t=$(ps eww -o command= -p "\${p%.json}" 2>/dev/null | grep -o 'HC_TERMINAL_ID=[^ ]*' | head -1)
  [ -n "$t" ] && printf 'S\\t%s\\t%s\\n' "$(sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' "$s")" "\${t#*=}"
done`;

// The subagents to show, each with the Herdr terminal of the session that started it.
export function parseSubagents(stdout, nowS) {
  const lines = stdout.split("\n").filter(Boolean);
  const terminals = new Map(lines.filter((l) => l.startsWith("S\t")).map((l) => l.split("\t").slice(1)));
  return lines.filter((l) => !l.startsWith("S\t")).flatMap((line) => {
    const [touched, born, session, raw] = line.split("\t");
    let meta;
    try { meta = JSON.parse(raw); } catch { return []; }
    const idle = nowS - Number(touched);
    const running = !meta.finished && idle < RUNNING_MAX_S;
    if (!running && !(meta.finished && idle < DONE_KEEP_S)) return [];
    return [{
      id: meta.toolUseId ?? `${session}-${born}`,
      terminal: terminals.get(session),
      running,
      task: meta.description || meta.agentType || "Subagent",
      type: meta.agentType ?? "agent",
      model: (meta.model ?? meta.pickedEffortModel ?? "").replace(/^claude-/, ""),
      born: Number(born),
      touched: Number(touched),
    }];
  }).sort((a, b) => a.born - b.born);
}

export function elapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
