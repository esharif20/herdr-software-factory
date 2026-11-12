// Where a dragged session lands. `shown` is the grid, across then down.
export const MAX_ZONES = 4;

// A session already in the grid can only trade places; a new one can also add a square.
export const zoneCount = (shown, address) => shown.includes(address) ? shown.length : Math.min(shown.length + 1, MAX_ZONES);

export function placed(shown, address, zone) {
  const next = [...shown];
  const from = next.indexOf(address);
  if (from >= 0) next[from] = next[zone];
  next[zone] = address;
  return next;
}
