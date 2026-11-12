// No tokens. Turns graphify-out/graph.json into the plan's code map, so the Lead and builders
// stop reading whole files to learn the layout. Per community (a group of files that call each
// other): each source file, how many other files use it, and its functions and classes with
// line numbers. Then the hub files several communities use: give each one owner or a scaffold.
//   node codemap.mjs <project dir>   (prints markdown; auto.sh writes it to .tsf/codemap.md)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/;
const EDGE = new Set(['calls', 'imports', 'imports_from', 'indirect_call', 're_exports']);
const MAX_SYMBOLS = 10, HUB_MIN = 4;

export function codemap(g) {
  const fileOf = new Map(g.nodes.map((n) => [n.id, n.source_file]));
  const files = new Map(); // path -> { community, symbols: [label Lnn], users: Set<path> }
  const at = (f) => files.get(f) ?? files.set(f, { community: '', symbols: [], users: new Set() }).get(f);
  for (const n of g.nodes) {
    if (n.file_type !== 'code' || !n.source_file || TEST.test(n.source_file)) continue;
    const f = at(n.source_file);
    if (n._callable) f.symbols.push(`${n.label} ${n.source_location ?? ''}`.trim());
    else if (!f.community) f.community = n.community_name ?? String(n.community);
  }
  for (const l of g.links) {
    if (!EDGE.has(l.relation)) continue;
    const from = fileOf.get(l.source), to = fileOf.get(l.target);
    if (from && to && from !== to && files.has(to) && !TEST.test(from)) files.get(to).users.add(from);
  }
  const groups = new Map();
  for (const [path, f] of files) (groups.get(f.community) ?? groups.set(f.community, []).get(f.community)).push([path, f]);
  const out = ['# Code map (from the Graphify graph; regenerate, never edit)', ''];
  for (const [name, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`## ${name || 'other'}`);
    for (const [path, f] of list.sort((a, b) => a[0].localeCompare(b[0]))) {
      const more = f.symbols.length > MAX_SYMBOLS ? ` +${f.symbols.length - MAX_SYMBOLS} more` : '';
      const syms = f.symbols.slice(0, MAX_SYMBOLS).join(', ');
      out.push(`- ${path} (used by ${f.users.size})${syms ? `: ${syms}${more}` : ''}`);
    }
    out.push('');
  }
  const hubs = [...files].filter(([, f]) => new Set([...f.users].map((u) => files.get(u)?.community)).size >= 2 && f.users.size >= HUB_MIN)
    .sort((a, b) => b[1].users.size - a[1].users.size);
  out.push('## Hub files (used across communities: one owner lane, or a scaffold commit first)');
  for (const [path, f] of hubs) out.push(`- ${path}: used by ${f.users.size} files`);
  return out.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? '.';
  process.stdout.write(codemap(JSON.parse(readFileSync(join(dir, 'graphify-out/graph.json'), 'utf8'))));
}
