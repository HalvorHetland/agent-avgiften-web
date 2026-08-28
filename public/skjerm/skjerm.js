/* Storskjermen — Agent-avgiften.
 *
 * Bygget fra Skjerm.dc.html. Tre forskjeller fra designfila, alle med grunn:
 *
 *  1. `setInterval` med oppdiktede tall er byttet mot Supabase Realtime.
 *     Skjermen abonnerer på en kringkasting fra en trigger på ai_runs og
 *     crank_runs, og henter aggregatet på nytt når noe skjer. Vi kunne ikke
 *     brukt postgres_changes: den speiler RLS, og anon har med vilje ingen
 *     SELECT på tabellene.
 *
 *  2. Det hardkodede 88× er byttet mot det MÅLTE forholdet. 88 kom fra
 *     korpuset (median rå 103 001 / median synlig 1 175), og er dessuten
 *     rå/synlig-tekst, mens standen måler rå/Readability. Se
 *     docs/omregningskonstanten.md og README.
 *
 *  3. Rå-armen kuttes ved 60 000 tokens av budsjetthensyn. Når noe er kuttet,
 *     sier skjermen at tallet er et gulv. Et kuttet tall presentert som
 *     fasit ville vært å pynte på målingen.
 */

const db = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// Telefonens adresse — QR-koden peker hit. Overstyr med ?telefon=...
const params = new URLSearchParams(location.search);
// Nettstedet kan ligge under en sti (GitHub Pages: /agent-avgiften-web/),
// så vi regner oss opp fra /skjerm/ i stedet for å anta domenerota.
const TELEFON_URL = params.get("telefon")
  || location.origin + location.pathname.replace(/skjerm\/.*$/, "");

const JOULE_PER_SPM = 864;   // 0,24 Wh, etterprøvd mot arXiv:2508.15734
const MAAL_JOULE = 8640;     // ti spørsmål

// Korpusmedianene, til kaldstart. Merket som korpus, aldri som «i dag».
const KORPUS = { raa: 103001, reint: 1175, forhold: 87.7 };

let T = null;        // siste booth_totals
let SVEIV = [];      // siste tolv økter
let forrige = {};    // for å pulse tall som har endret seg

// ─────────────────────────────────────────────────────────────── formatering

const sep = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const komma = (n, d = 1) => (Math.round(Number(n) * 10 ** d) / 10 ** d).toString().replace(".", ",");

/** Pulser tallet hvis det har endret seg siden forrige tegning. */
function nytt(nokkel, verdi) {
  const endret = forrige[nokkel] !== undefined && forrige[nokkel] !== verdi;
  forrige[nokkel] = verdi;
  return endret ? " puls" : "";
}

// ────────────────────────────────────────────────────────────────── henting

async function hent() {
  try {
    const [t, s] = await Promise.all([
      db.from("booth_totals").select("*").single(),
      db.from("siste_sveiv").select("*"),
    ]);
    if (t.error) throw t.error;
    T = t.data;
    SVEIV = s.data ?? [];
    document.getElementById("frakoblet").classList.remove("vis");
  } catch {
    // Behold siste kjente tall og si fra. Bedre enn en tom skjerm, og langt
    // bedre enn et tall vi ikke vet er sant.
    document.getElementById("frakoblet").classList.add("vis");
  }
  tegn();
}

/* Realtime. Triggeren kringkaster på topic 'booth' ved hver innsetting;
 * nyttelasten er bevisst nesten tom, så skjermen henter aggregatet på nytt.
 *
 * Polling hvert 15. sekund ligger under som sikkerhetsnett. Realtime kan falle
 * ut på et konferansenett, og en skjerm som står stille i to timer er verre
 * enn noen ekstra spørringer. */
db.realtime.setAuth();   // privat kanal signeres med anon-nøkkelen
db.channel("booth", { config: { private: true } })
  .on("broadcast", { event: "endring" }, () => hent())
  .subscribe();

setInterval(hent, 15000);
hent();

// ──────────────────────────────────────────────────────────────── utregning

function tallene() {
  const kaldstart = !T || Number(T.kall) === 0;

  const raa = kaldstart ? KORPUS.raa : Number(T.tokens_raa);
  const reint = kaldstart ? KORPUS.reint : Number(T.tokens_reint);
  const forhold = reint > 0 ? raa / reint : 0;

  const kall = kaldstart ? 0 : Number(T.kall);
  const joules = T ? Number(T.joules) : 0;
  const wh = joules / 3600;
  const aiJoule = kall * JOULE_PER_SPM;
  const dekning = aiJoule > 0 ? (joules / aiJoule) * 100 : 0;
  const mangler = Math.max(0, MAAL_JOULE - (joules % MAAL_JOULE));

  return {
    kaldstart, raa, reint, forhold, kall, joules, wh, dekning, mangler,
    spoersmaal: T ? Number(T.spoersmaal) : 0,
    sveiveoekter: T ? Number(T.sveiveoekter) : 0,
    kuttede: T ? Number(T.kuttede_kall) : 0,
    brukt: T ? Number(T.brukt_usd) : 0,
    budsjett: T ? Number(T.budsjett_usd) : 0,
  };
}

// ──────────────────────────────────────────────────────────────────── QR
//
// Koden er en fast URL, så den genereres på forhånd som SVG i stedet for å
// dra et QR-bibliotek inn i nettleseren:
//
//   node verify/lag-qr.mjs https://din.adresse/telefon/
//
// Finnes ikke fila enda, står designets plassholder igjen — LES-MEG.md er
// tydelig på at `[QR-kode settes inn]` er bevisst design, ikke uferdig.
function qrMarkup() {
  return `<img src="./qr.svg" alt="QR-kode til telefonflyten" width="136" height="136"
    style="display:block;width:136px;height:136px;flex-shrink:0;border-radius:8px;background:#ededed"
    onerror="this.replaceWith(Object.assign(document.createElement('div'),{
      className:'qr-mangler',
      textContent:'[QR-kode settes inn]',
      style:'width:136px;height:136px;flex-shrink:0;border:2px dashed #3d3d3d;border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:13px;color:#5a5a5a;padding:10px;line-height:1.4'
    }))">`;
}

// ───────────────────────────────────────────────────────────────── tegning

function tegn() {
  const d = tallene();

  const soyler = (() => {
    if (!SVEIV.length) {
      return Array.from({ length: 12 }, () =>
        `<div style="flex-grow:1;border-radius:3px;height:4%;background:#1a1a1a"></div>`).join("");
    }
    const maks = Math.max(...SVEIV.map((s) => Number(s.joules)), 1);
    // Eldste til venstre, nyeste til høyre — slik man leser en tidslinje.
    const rekke = [...SVEIV].reverse();
    const tomme = 12 - rekke.length;
    return Array.from({ length: tomme }, () =>
      `<div style="flex-grow:1;border-radius:3px;height:4%;background:#1a1a1a"></div>`).join("")
      + rekke.map((s) => {
        const h = Math.max(6, (Number(s.joules) / maks) * 100);
        const c = h > 85 ? "#4ade80" : (h > 60 ? "#2b5233" : "#1e3a24");
        return `<div style="flex-grow:1;border-radius:3px;height:${h}%;background:${c}"></div>`;
      }).join("");
  })();

  const siste = SVEIV[0];
  const sisteTekst = siste
    ? `${sep(siste.joules)} J${siste.peak_watts ? " · " + komma(siste.peak_watts, 0) + " W topp" : ""}`
    : "ingen enda";

  // Den grønne søyla i forhold til den oransje. Minst 6 px så den er synlig.
  const reintBredde = d.raa > 0 ? Math.max(0.2, (d.reint / d.raa) * 100) : 0;

  document.getElementById("rot").innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;gap:40px">
    <div class="kol" style="gap:10px">
      <div class="lbl" style="color:#f97316">Energiregnskap · standen i dag</div>
      <div class="disp" style="font-size:52px;font-weight:700;line-height:1">Hva koster det å spørre?</div>
    </div>
    <div style="display:flex;align-items:center;gap:22px;padding:16px 24px;flex-shrink:0" class="kort">
      ${qrMarkup()}
      <div class="kol" style="gap:9px">
        <div class="disp" style="font-size:28px;font-weight:700;line-height:1.1">Skann og prøv selv</div>
        <div style="font-size:17px;color:#9a9a9a;line-height:1.4">Velg en side, still ditt eget<br>spørsmål — omtrent ett minutt</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:3px">
          <div style="width:10px;height:10px;border-radius:999px;background:#4ade80"></div>
          <div class="mono" style="font-size:15px;color:#9a9a9a">oppdaterer live</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;gap:30px;flex-grow:1;min-height:0">

    <div class="kort kol" style="flex-grow:1;gap:24px;padding:38px;border-color:#3a2412;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="lbl" style="color:#f97316">AI-en har brukt${d.kaldstart ? " · korpus, ikke i dag" : ""}</div>
        ${d.kuttede > 0 ? `<div class="mono" style="font-size:15px;color:#fbbf24">${d.kuttede} av ${d.kall} kall ble kuttet — tallene er et gulv</div>` : ""}
      </div>
      <div style="display:flex;align-items:baseline;gap:15px">
        <div class="mono disp${nytt("raa", d.raa)}" style="font-size:96px;font-weight:500;line-height:0.9;color:#f97316">${sep(d.raa)}</div>
        <div style="font-size:24px;color:#9a9a9a">tokens</div>
      </div>

      <div class="kol" style="gap:15px">
        <div class="kol" style="gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:21px;color:#ededed">Hele siden slik den er kodet</span>
            <span class="mono" style="font-size:21px;color:#fb923c">${sep(d.raa)}</span>
          </div>
          <div style="height:42px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:100%;height:100%;background:#f97316"></div></div>
        </div>
        <div class="kol" style="gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:21px;color:#ededed">Bare teksten på siden</span>
            <span class="mono" style="font-size:21px;color:#4ade80">${sep(d.reint)}</span>
          </div>
          <div style="height:42px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:${reintBredde}%;min-width:6px;height:100%;background:#4ade80"></div></div>
        </div>
      </div>

      <div style="display:flex;margin-top:auto;padding-top:24px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall${nytt("spm", d.spoersmaal)}">${sep(d.spoersmaal)}</div>
          <div class="statNavn">spørsmål stilt</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall${nytt("kall", d.kall)}">${sep(d.kall)}</div>
          <div class="statNavn">kall til modellen</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall${nytt("forhold", Math.round(d.forhold))}" style="color:#fb923c">${d.forhold < 10 ? komma(d.forhold) : sep(d.forhold)}<span style="font-size:23px;color:#9a9a9a">×</span></div>
          <div class="statNavn">dyrere enn nødvendig${d.kuttede > 0 ? ", minst" : ""}</div>
        </div>
      </div>
    </div>

    <div class="kort kol" style="width:640px;flex-shrink:0;gap:24px;padding:38px;border-color:#1e3a24">
      <div class="lbl" style="color:#4ade80">Dere har sveivet</div>
      <div style="display:flex;align-items:baseline;gap:15px">
        <div class="mono disp${nytt("joules", d.joules)}" style="font-size:96px;font-weight:500;line-height:0.9;color:#4ade80">${sep(d.joules)}</div>
        <div style="font-size:24px;color:#9a9a9a">joule</div>
      </div>

      <div class="kol" style="gap:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:19px;color:#9a9a9a">Siste økt</span>
          <span class="mono" style="font-size:19px">${sisteTekst}</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:6px;height:150px">${soyler}</div>
        <div style="font-size:16px;color:#6b6b6b">siste tolv økter</div>
      </div>

      <div style="display:flex;margin-top:auto;padding-top:24px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall${nytt("oekter", d.sveiveoekter)}">${sep(d.sveiveoekter)}</div>
          <div class="statNavn">som har sveivet</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall">${komma(d.wh)}<span style="font-size:23px;color:#9a9a9a"> Wh</span></div>
          <div class="statNavn">samlet</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:40px;padding:30px 38px;background:#0e0e0e;border:1px solid #282828;border-left:5px solid #fbbf24;border-radius:12px">
    <div class="kol" style="gap:7px;flex-shrink:0">
      <div class="mono disp" style="font-size:60px;font-weight:500;line-height:1;color:#fbbf24">${d.dekning > 0 && d.dekning < 1 ? komma(d.dekning) : Math.round(d.dekning)} %</div>
      <div style="font-size:18px;color:#9a9a9a">av strømmen er sveivet inn</div>
    </div>
    <div style="width:1px;align-self:stretch;background:#282828"></div>
    <div class="kol" style="gap:8px;flex-grow:1">
      <div style="font-size:22px;color:#ededed;line-height:1.45">Neste mål: <span class="mono" style="color:#4ade80">8 640 J</span> — nok til de ti neste spørsmålene. Dere mangler <span class="mono" style="color:#fbbf24">${sep(d.mangler)} J</span>.</div>
      <div style="font-size:16px;color:#6b6b6b;line-height:1.5">Omregning: 0,24 Wh per forespørsel (Google, 2025 — median tekstforespørsel). Våre råe spørsmål er mye større enn en median forespørsel, så dette er et gulv, ikke et estimat.</div>
    </div>
    <div class="kol" style="gap:6px;flex-shrink:0;align-items:flex-end;padding-left:30px;border-left:1px solid #282828">
      <div class="mono" style="font-size:20px;color:${d.brukt / (d.budsjett || 1) > 0.8 ? "#fbbf24" : "#6b6b6b"}">${komma(d.brukt, 2)} / ${komma(d.budsjett, 2)} $</div>
      <div style="font-size:15px;color:#5a5a5a">av dagens budsjett</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────── skalering

/* Designet er 1920x1080. Vi skalerer hele flata til vinduet i stedet for å
 * gjøre layouten responsiv, slik at proporsjonene i designet holder på hvilken
 * som helst projektor. */
function skaler() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  const scene = document.getElementById("scene");
  const rot = document.getElementById("rot");
  // transform endrer ikke layoutboksen, så innpakningen må få de skalerte
  // målene mens innholdet skaleres. Ett element kan ikke gjøre begge deler.
  rot.style.transformOrigin = "top left";
  rot.style.transform = `scale(${s})`;
  scene.style.width = Math.round(1920 * s) + "px";
  scene.style.height = Math.round(1080 * s) + "px";
}
// `resize` alene er ikke nok: en projektor som kobles til bytter oppløsning
// uten at hendelsen alltid fyrer, og skaleringen ville blitt stående på det
// laptopskjermen hadde ved lasting. ResizeObserver fanger enhver endring.
new ResizeObserver(skaler).observe(document.documentElement);
addEventListener("resize", skaler);
addEventListener("load", skaler);
skaler();
