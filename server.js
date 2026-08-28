/* Statisk filserver for standen.
 *
 * Null avhengigheter, med vilje. Dette er en utstilling som skal stå stødig i
 * noen timer, ikke et prosjekt som skal vedlikeholdes — og en `npm install`
 * som feiler på standdagen er en risiko uten gevinst.
 *
 * Ingen hemmeligheter her. Serveren leverer bare filer. OpenAI-nøkkelen ligger
 * fortsatt kun som secret i Supabase Edge-funksjonen, og telefonen snakker
 * direkte med den — denne serveren er aldri i den veien.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROT = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const TYPER = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("ugyldig sti");
    return;
  }

  // Mappe → index.html, slik at både / og /skjerm/ virker.
  if (rel.endsWith("/")) rel += "index.html";

  // Normaliser og hold oss innenfor public/. Uten dette kan ../ leses ut.
  const fil = path.join(ROT, path.normalize(rel));
  if (!fil.startsWith(ROT + path.sep) && fil !== path.join(ROT, "index.html")) {
    res.writeHead(403).end("nei");
    return;
  }

  fs.readFile(fil, (feil, data) => {
    if (feil) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Ikke funnet");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPER[path.extname(fil)] || "application/octet-stream",
      // Kort cache. Skjermen står i timevis, og en gammel fil som henger igjen
      // på standdagen er verre enn noen ekstra nedlastinger.
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`standen serveres på :${PORT}`));
