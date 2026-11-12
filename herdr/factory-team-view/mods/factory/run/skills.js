// What the skill map means for the views: weights, a lane's one-line summary, what can be added.
// No Herdr imports, so skills.test.mjs runs it under plain node.

// A skill's weight in context: about 4 bytes of SKILL.md per token.
export const tokensOf = (bytes) => Math.round((bytes ?? 0) / 4);
export const shortCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function groupTokens(group, installed) {
  const size = new Map(installed.map((s) => [s.name, s.bytes]));
  return group.skills.reduce((sum, name) => sum + tokensOf(size.get(name)), 0);
}

// `skills web: frontend motion animate` -> "ui-ux-pro-max · shadcn · impeccable · +animate": a group shows its
// skills, a skill named on its own shows with +. `always` is distilled into the plan's rules, not loaded by a lane.
export function laneSummary(tokens, groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = [];
  for (const tok of tokens) {
    if (tok === "always") continue;
    for (const name of byId.get(tok)?.skills ?? [`+${tok}`]) if (!out.includes(name)) out.push(name);
  }
  return out.join(" · ");
}

// Names not already there, matching the query anywhere, case aside.
export function addable(names, have, query) {
  const q = query.trim().toLowerCase();
  return names.filter((n) => !have.includes(n) && (!q || n.toLowerCase().includes(q)));
}
