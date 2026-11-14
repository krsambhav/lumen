// Draws Lumen's app icon and renders it to src-tauri/icons/source.png, the
// input for `tauri icon`. The same drawing is written to assets/icon.svg.
//
// The mark is a lens-barrel ring of engraved ticks around a play mark, with a
// single tick lit in the accent: the instrument and its one lamp (DESIGN.md §1).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(import.meta.dirname, "..");

const IVORY = "#efefe6";
const LIMELIGHT = "#ece45c";
const CENTER = { x: 512, y: 512 };
const RADIUS = 304;
/** The one lit mark on the ring, at two o'clock. */
const LIT_ANGLE = 60;

const f = (n) => n.toFixed(2);

/** A point on the ring; 0° is straight up, positive is clockwise. */
function polar(angle, radius) {
  const rad = (angle * Math.PI) / 180;
  return {
    x: CENTER.x + radius * Math.sin(rad),
    y: CENTER.y - radius * Math.cos(rad),
  };
}

function tick(angle, length, width, colour, opacity) {
  const outer = polar(angle, RADIUS);
  const inner = polar(angle, RADIUS - length);
  return `<line x1="${f(inner.x)}" y1="${f(inner.y)}" x2="${f(outer.x)}" y2="${f(outer.y)}" stroke="${colour}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round"/>`;
}

// A lens-barrel ring: 48 even marks, so it reads as knurling rather than as
// the twelve hours of a clock. The lit mark replaces the one at two o'clock.
const ticks = [];
for (let index = 0; index < 48; index += 1) {
  const angle = index * 7.5;
  if (angle === LIT_ANGLE) {
    ticks.push(tick(angle, 78, 22, LIMELIGHT, 1));
  } else {
    ticks.push(tick(angle, 40, 11, IVORY, 0.46));
  }
}

// The play mark, nudged right so it sits optically centred in the ring.
const play = { left: 448, right: 624, half: 104 };
const playPath = `M${play.left} ${CENTER.y - play.half} L${play.right} ${CENTER.y} L${play.left} ${CENTER.y + play.half} Z`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2b26"/>
      <stop offset="1" stop-color="#11110e"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${IVORY}" stop-opacity="0.22"/>
      <stop offset="0.5" stop-color="${IVORY}" stop-opacity="0.04"/>
      <stop offset="1" stop-color="${IVORY}" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="124%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.38"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#body)" filter="url(#shadow)"/>
  <rect x="103" y="103" width="818" height="818" rx="183" fill="none" stroke="url(#rim)" stroke-width="6"/>
  ${ticks.join("\n  ")}
  <path d="${playPath}" fill="${IVORY}" stroke="${IVORY}" stroke-width="40" stroke-linejoin="round"/>
</svg>
`;

writeFileSync(path.join(root, "assets", "icon.svg"), svg);

const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
const outDir = path.join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "source.png"), png);
console.log(`icon: ${png.length} bytes -> src-tauri/icons/source.png`);
