#!/usr/bin/env node
/**
 * Lager QR-koden storskjermen viser, som SVG.
 *
 * Designet har `[QR-kode settes inn]` som en bevisst plassholder — LES-MEG.md
 * sier den skal fylles når verdien finnes. Kjør denne når du vet hvor
 * telefonflyten hostes:
 *
 *   node tools/lag-qr.mjs https://halvorhetland.no/agent-avgiften-web/
 *
 * SVG og ikke PNG: skjermen er en projektor, og en vektor er skarp uansett
 * oppløsning. Koderen er vendret fra qrcode-terminal (MIT) — se vendor/.
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const her = dirname(fileURLToPath(import.meta.url));
const QRCode = require(join(her, "vendor/QRCode/index.js"));

const url = process.argv[2];
if (!url) {
  console.error("Bruk: node tools/lag-qr.mjs <url>");
  process.exit(2);
}

// Nivå M tåler ~15 % skade. Nok for en skjerm; ikke så tett at den blir
// vanskelig å lese fra avstand.
const qr = new QRCode(-1, 0);   // -1 = velg minste versjon som holder, 0 = M
qr.addData(url);
qr.make();

const n = qr.getModuleCount();
const marg = 2;                 // stille sone, i moduler
const total = n + marg * 2;

const ruter = [];
for (let r = 0; r < n; r++) {
  for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ruter.push(`M${c + marg} ${r + marg}h1v1h-1z`);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR-kode til ${url}">
<rect width="${total}" height="${total}" fill="#ededed"/>
<path d="${ruter.join("")}" fill="#0a0a0a"/>
</svg>
`;

const ut = join(her, "..", "public", "skjerm", "qr.svg");
writeFileSync(ut, svg);
console.log(`QR skrevet: ${ut}`);
console.log(`  url      ${url}`);
console.log(`  versjon  ${(n - 17) / 4}  (${n}x${n} moduler)`);
