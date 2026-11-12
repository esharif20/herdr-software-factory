import assert from 'node:assert/strict';
import { codemap } from './codemap.mjs';

const n = (id, file, community, callable, line) => ({ id, label: id, source_file: file, file_type: 'code', community_name: community, _callable: callable, source_location: line });
const nodes = [n('core', 'src/core.mjs', 'core', false), n('helper', 'src/core.mjs', 'core', true, 'L3')];
const links = [];
for (const [i, c] of ['a', 'a', 'b', 'b'].entries()) {
  nodes.push(n(`f${i}`, `src/${c}${i}.mjs`, c, false), n(`fn${i}`, `src/${c}${i}.mjs`, c, true, 'L1'));
  links.push({ source: `fn${i}`, target: 'helper', relation: 'calls' });
}
nodes.push(n('t', 'test/core.test.mjs', 'core', false), n('tfn', 'test/core.test.mjs', 'core', true, 'L1'));
links.push({ source: 'tfn', target: 'helper', relation: 'calls' }, { source: 'fn0', target: 'helper', relation: 'contains' });

const md = codemap({ nodes, links });
assert.match(md, /- src\/core\.mjs \(used by 4\): helper L3/); // test files and `contains` don't count as users
assert.match(md, /## Hub files[^\n]*\n- src\/core\.mjs: used by 4 files/); // used from two communities
assert.doesNotMatch(md, /core\.test\.mjs/);
assert.match(md, /- src\/a0\.mjs \(used by 0\): fn0 L1/);
console.log('ok');
