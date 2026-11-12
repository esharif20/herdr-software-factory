// shortcut: reads the "⏺"/"●"/"•" message markers agents draw on screen; an agent
// that draws none falls back to its title.
const MESSAGE = /^\s*[⏺●•]\s+(.*)$/;
const MAX_LINES = 3;

// The agent's latest message on screen, with the lines that continue it.
export function latestActivity(screen) {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = MESSAGE.exec(lines[i]);
    if (!found) continue;
    const parts = [found[1].trim()];
    for (let j = i + 1; j < lines.length && parts.length < MAX_LINES; j++) {
      // A message's wrapped lines are indented; anything else is the next block.
      if (!/^\s{2,}[^\s⎿│╭╰─]/.test(lines[j])) break;
      parts.push(lines[j].trim());
    }
    return parts.join(" ");
  }
  return null;
}
