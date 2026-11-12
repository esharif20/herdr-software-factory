// shortcut: Herdr has no feed of sends, so they are inferred from what's on screen each poll.
// A message that scrolled off between polls is missed; an identical repeat still on screen too.
// Pasted `hc send` reports only: a prompt marker, then the tag. Code or a diff showing the tag has no such marker.
const HC_MESSAGE = /^\s*[❯›⟩>]\s*<hc(?:\s+from="([^"]+)")?(?:\s+\w+="[^"]*")*>(.*?)(?:<\/hc>)?\s*$/;

// `from` is "t3 reviewer"; a report with no from opens with its address.
export function hcMessages(screen) {
  return screen.split("\n").flatMap((line) => {
    const found = HC_MESSAGE.exec(line);
    if (!found) return [];
    const from = found[1]?.split(" ")[0] ?? /^(\S+)\s/.exec(found[2])?.[1];
    return from ? [{ from, text: found[2].trim() }] : [];
  });
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// A resized terminal rewraps, so the same message can come back cut at a different point.
const MIN_REWRAP_CHARS = 20; // shorter than this, a shared start is just two different messages
const sameMessage = (a, b) => a.from === b.from && (a.text === b.text
  || (Math.min(a.text.length, b.text.length) >= MIN_REWRAP_CHARS && (a.text.startsWith(b.text) || b.text.startsWith(a.text))));

// What was sent since the last poll. now: { statuses: {address: status}, messages: {address: [...]}, subagents: [...] }.
// Everything first seen is the starting point, not a send.
export function detect(previous, now) {
  if (!previous) return [];
  const events = [];
  const received = new Set();
  for (const [to, messages] of Object.entries(now.messages)) {
    if (!previous.messages[to]) continue;
    for (const m of messages) {
      if (previous.messages[to].some((old) => sameMessage(old, m)) || !has(now.statuses, m.from)) continue;
      events.push({ from: m.from, to, text: m.text });
      received.add(to);
    }
  }
  for (const [to, status] of Object.entries(now.statuses)) {
    const was = previous.statuses[to];
    // The report can land a poll before the turn it starts, so it counts for this poll and the next.
    // Without its screen a teammate's send can't be told from the person's, so only shown sessions count.
    if (now.messages[to] && was && was !== "working" && status === "working" && !received.has(to) && !previous.received?.has(to)) events.push({ from: "you", to, text: "" });
  }
  const seen = new Set(previous.subagents.map((s) => s.id));
  for (const s of now.subagents) {
    if (!seen.has(s.id) && has(now.statuses, s.terminal)) events.push({ from: s.terminal, to: s.terminal, subagent: true, text: s.task });
  }
  now.received = received;
  return events;
}
