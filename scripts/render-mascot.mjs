#!/usr/bin/env node
// Renders the TUI intro from src/tui/transcript.tsx, where the Claude mascot
// drinks a glass of juice, as a looping animated SVG for the README. Each tick
// is drawn the way the terminal draws it, one cell at a time, so keep the two
// in step when the intro changes.
//
//   node scripts/render-mascot.mjs > docs/assets/juiced-mascot.svg
const mascot = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '];
const juice = '#4eba65';
const fizz = '#b4f0c1', sipping = '#7ee695', glass = '#a9c4bf', lime = '#c5e86c', stripe = '#e5484d';
const claude = [0xd9, 0x77, 0x57], green = [0x4e, 0xba, 0x65];
const blend = t => `#${claude.map((from, i) => Math.round(from + (green[i] - from) * t).toString(16).padStart(2, '0')).join('')}`;
const clamp = value => Math.min(1, Math.max(0, value));

// The TUI ticks every 70ms and hands over to the header at tick 29. The README
// loop holds the green mascot a while before the next glass.
const tickMs = 70, introTicks = 29, loopTicks = 72;
const cellW = 12, cellH = 24, padX = 24, padY = 20, columns = 16;
const width = columns * cellW + 2 * padX, height = 3 * cellH + 2 * padY;

const n = value => +value.toFixed(2);
const rect = (x, y, w, h, fill) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;

// Block and box glyphs as rectangles in cell units: [x, y, w, h].
const line = 4 / cellH, post = 4 / cellW;
const blocks = {
  '█': [[0, 0, 1, 1]], '▌': [[0, 0, .5, 1]], '▐': [[.5, 0, .5, 1]], '▄': [[0, .5, 1, .5]],
  '▘': [[0, 0, .5, .5]], '▝': [[.5, 0, .5, .5]], '▛': [[0, 0, 1, .5], [0, .5, .5, .5]], '▜': [[0, 0, 1, .5], [.5, .5, .5, .5]],
  '▕': [[7 / 8, 0, 1 / 8, 1]], '▏': [[0, 0, 1 / 8, 1]],
  '━': [[0, .5 - line / 2, 1, line]], '┃': [[.5 - post / 2, 0, post, 1]],
  '┓': [[0, .5 - line / 2, .5 + post / 2, line], [.5 - post / 2, .5 - line / 2, post, .5 + line / 2]],
};
const star = (cx, cy, outer, inner) => `M${cx} ${cy - outer}L${n(cx + inner)} ${n(cy - inner)}L${cx + outer} ${cy}L${n(cx + inner)} ${n(cy + inner)}L${cx} ${cy + outer}L${n(cx - inner)} ${n(cy + inner)}L${cx - outer} ${cy}L${n(cx - inner)} ${n(cy - inner)}Z`;

/** Draws one terminal cell: a glyph with a foreground, background and underline. */
function cell(row, column, glyph, { color, background, underline } = {}) {
  const x = padX + column * cellW, y = padY + row * cellH, out = [];
  if (background) out.push(rect(x, y, cellW, cellH, background));
  for (const [bx, by, bw, bh] of blocks[glyph] ?? []) out.push(rect(x + bx * cellW, y + by * cellH, bw * cellW, bh * cellH, color));
  const cx = x + cellW / 2, cy = y + cellH / 2;
  if (glyph === '°') out.push(`<circle cx="${cx}" cy="${y + 7}" r="2.2" fill="none" stroke="${color}" stroke-width="1.2"/>`);
  if (glyph === '∘') out.push(`<circle cx="${cx}" cy="${cy + 1}" r="2.6" fill="none" stroke="${color}" stroke-width="1.2"/>`);
  if (glyph === '◗') out.push(`<path d="M${x + 3} ${cy - 5}a5 5 0 0 1 0 10Z" fill="${color}"/>`);
  if (glyph === '✦') out.push(`<path d="${star(cx, cy, 6, 1.6)}" fill="${color}"/>`);
  if (glyph === '✧') out.push(`<path d="${star(cx, cy, 5.5, 1.6)}" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>`);
  if (underline) out.push(rect(x, y + cellH - 2, cellW, 1.5, color));
  return out.join('');
}

const text = (row, start, chars, color) => [...chars].map((glyph, i) => cell(row, start + i, glyph, { color })).join('');

/** One tick of the intro, mirroring Intro in src/tui/transcript.tsx. */
function frame(tick) {
  if (tick >= 23) {
    const sparkle = (row, column, on) => on && tick < introTicks ? cell(row, column, tick % 2 ? '✦' : '✧', { color: juice }) : '';
    return mascot.map((chars, i) => text(i, 0, chars, juice) + sparkle(i, 10, i !== 1) + sparkle(i, 12, i === 1)).join('');
  }
  const sip = clamp((tick - 6) / 14);
  const level = Math.ceil(4 * (1 - sip));
  const color = blend(sip * sip * (3 - 2 * sip));
  const full = row => level >= 4 - 2 * row;
  const wet = segment => segment < (tick - 2) * 2 && segment >= (tick - 20) * 3;
  const straw = (row, column, segment, glyph, background) => cell(row, column, glyph, { color: wet(segment) ? sipping : segment % 2 ? stripe : 'white', background, underline: segment === 0 });
  const cup = row => {
    const out = [cell(row + 1, 10, '▕', { color: glass }), cell(row + 1, 15, '▏', { color: glass })];
    for (const column of [0, 1, 2, 3]) {
      if (column === 2) { out.push(straw(row + 1, 13, 1 - row, '┃', full(row) ? juice : undefined)); continue; }
      const bubble = tick < 20 && (column === 0 || column === 3) && Math.floor(tick / 3 + column) % 2 === 1 - row;
      const surface = level === 3 - 2 * row;
      out.push(full(row)
        ? cell(row + 1, 11 + column, bubble ? (row ? '∘' : '°') : ' ', { color: fizz, background: juice, underline: row === 1 })
        : cell(row + 1, 11 + column, surface ? '▄' : ' ', { color: surface ? juice : glass, underline: row === 1 }));
    }
    return out.join('');
  };
  return text(0, 0, mascot[0].trimEnd(), color)
    + [7, 6, 5, 4, 3].map((segment, i) => straw(0, 8 + i, segment, '━')).join('')
    + straw(0, 13, 2, '┓') + cell(0, 15, '◗', { color: lime })
    + text(1, 0, mascot[1], color) + cup(0)
    + text(2, 0, mascot[2], color) + cup(1);
}

// Identical ticks share one group, shown only on its ticks. Without SMIL the
// last frame, the green mascot, is the one left visible.
const frames = new Map();
for (let tick = 0; tick < loopTicks; tick++) {
  const body = frame(Math.min(tick, introTicks));
  if (!frames.has(body)) frames.set(body, []);
  frames.get(body).push(tick);
}
const last = frame(introTicks);
const groups = [...frames].map(([body, ticks]) => {
  const keyTimes = [], values = [];
  for (let tick = 0; tick < loopTicks; tick++) {
    const value = ticks.includes(tick) ? 'visible' : 'hidden';
    if (values.at(-1) !== value) { keyTimes.push(n(tick / loopTicks)); values.push(value); }
  }
  return `<g visibility="${body === last ? 'visible' : 'hidden'}"><animate attributeName="visibility" dur="${loopTicks * tickMs / 1000}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${keyTimes.join(';')}" values="${values.join(';')}"/>${body}</g>`;
});

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="The Claude mascot drinks a glass of juice through a straw and turns green">
<rect width="${width}" height="${height}" rx="12" fill="#1f1e1d"/>
<style>rect{shape-rendering:crispEdges}</style>
${groups.join('\n')}
</svg>
`);
