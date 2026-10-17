/**
 * Regression guard for sideways page scroll.
 *
 * The bug this catches: a grid/flex item's automatic minimum size is its
 * *content* size (`min-width: auto`), so any wide, unshrinkable descendant —
 * a <pre> with a long line, a table with `min-w-[...]` — widens its track.
 * One level up, that becomes the whole page scrolling sideways.
 *
 * `overflow-x: auto` on the wide element does NOT prevent this: a scroll
 * container still contributes its content size to intrinsic sizing. Only
 * `min-w-0` on the grid/flex item (or a `minmax(0, …)` track) lets it shrink.
 *
 * So for every <pre>/<table> in the built output we walk up the ancestor chain
 * and require one of:
 *   - an ancestor with `overflow-hidden` (it is clipped), or
 *   - `min-w-0` on the element that is the direct child of the grid/flex box, or
 *   - a track template that already floors at 0 (`minmax(0, …)`).
 *
 * Run after `astro build`:  node scripts/check-horizontal-overflow.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'dist/client';
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);
// Elements whose min-content width can exceed a phone viewport.
const WIDE = new Set(['pre', 'table']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.html')) out.push(p);
  }
  return out;
}

/** Minimal HTML parser: enough to get a parent chain for each node. */
function parse(html) {
  const root = { tag: '#doc', attrs: {}, parent: null };
  let cur = root;
  const wide = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;

  let m;
  while ((m = tagRe.exec(html))) {
    const [, closing, tag, attrText] = m;
    if (closing) {
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    const name = tag.toLowerCase();
    const node = { tag: name, attrs, parent: cur };
    if (WIDE.has(name)) wide.push(node);
    if (!VOID.has(name)) cur = node;
  }
  return wide;
}

const toks = (n) => new Set((n.attrs.class ?? '').split(/\s+/));
const has = (n, t) => toks(n).has(t);

let checked = 0;
let failures = 0;
const pages = walk(ROOT).sort();

for (const file of pages) {
  const wide = parse(readFileSync(file, 'utf8'));
  const page = file.slice(ROOT.length) || '/';

  for (const el of wide) {
    checked++;
    const chain = [];
    for (let n = el; n && n.tag !== '#doc'; n = n.parent) chain.push(n);

    const clipped = chain.find((c) => has(c, 'overflow-hidden'));
    if (clipped) continue;

    const containerIdx = chain.findIndex((c) => has(c, 'grid') || has(c, 'flex'));
    const container = containerIdx === -1 ? null : chain[containerIdx];
    const item = containerIdx > 0 ? chain[containerIdx - 1] : null;

    if (container && toks(container).has('min-w-0')) continue;
    if (item && has(item, 'min-w-0')) continue;
    const tmpl = container ? [...toks(container)].find((t) => t.includes('minmax(0')) : null;
    if (tmpl) continue;

    failures++;
    console.error(`\n  ✗ ${page} — <${el.tag}> can push the page sideways`);
    console.error(`      ancestor grid/flex : ${container?.attrs.class ?? '(none)'}`);
    console.error(`      item on that path  : ${item?.attrs.class ?? '(none)'}`);
    console.error(
      `      fix                : add \`min-w-0\` to the item, or \`minmax(0, …)\` to the track`,
    );
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} of ${checked} wide elements are unguarded — the page can scroll sideways.\n`,
  );
  process.exit(1);
}

console.log(`✓ ${checked} wide elements checked across ${walk(ROOT).length} pages — none can force horizontal scroll`);
