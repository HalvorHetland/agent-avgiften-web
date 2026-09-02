/* Storskjermen — Agent-avgiften.
 *
 * Bygget fra Skjerm.dc.html. Tre forskjeller fra designfila, alle med grunn:
 *
 *  1. `setInterval` med oppdiktede tall er byttet mot Supabase Realtime.
 *     Skjermen abonnerer på en kringkasting fra en trigger på ai_runs og
 *     ai_runs, og henter aggregatet på nytt når noe skjer. Vi kunne ikke
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


// Korpusmedianene, til kaldstart. Merket som korpus, aldri som «i dag».
const KORPUS = { raa: 103001, reint: 1175, forhold: 87.7 };

let T = null;        // siste booth_totals
let SISTE = [];      // siste innleverte målinger
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
    /* Navngitte felter, ikke posisjonell destrukturering. En spørring som
     * legges til eller fjernes midt i lista har før byttet om på resultatene
     * og gitt svart skjerm. */
    const svar = {};
    await Promise.all([
      db.from("booth_totals").select("*").single().then((r) => { svar.totaler = r; }),
      db.from("siste_maalinger").select("*").then((r) => { svar.siste = r; }),
    ]);
    if (svar.totaler.error) throw svar.totaler.error;
    T = svar.totaler.data;
    SISTE = svar.siste.data ?? [];
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
  // Bare våre egne kall. Den felles potten med Gjermund hører til lagtavla —
  // hadde den stått her, ville en nullstilling av vår side latt hans tall bli
  // stående på denne skjermen.
  /* Energien er nå summen av to adskilte metoder, begge per rad i basen:
   *   dekoding_wh — EcoLogits 0.11.1 (skalerer med output-tokens)
   *   lesing_wh   — FLOP-basert leseestimat (skalerer med input-tokens),
   *                 se stand-repoets lesing.ts for kilder og bånd
   * Reserven kall × 0,24 gjelder bare rader uten metode (før byttet). */
  const dekodingWh = T ? Number(T.dekoding_wh) : 0;
  const lesingWh = T ? Number(T.lesing_wh) : 0;
  const lesingMin = T ? Number(T.lesing_wh_min) : 0;
  const lesingMaks = T ? Number(T.lesing_wh_max) : 0;
  const harMetode = dekodingWh > 0 || lesingWh > 0;
  const aiWh = harMetode ? dekodingWh + lesingWh : kall * 0.24;

  return {
    kaldstart, raa, reint, forhold, kall,
    spoersmaal: T ? Number(T.spoersmaal) : 0,
    kuttede: T ? Number(T.kuttede_kall) : 0,
    raa_tegn: T ? Number(T.raa_tegn) : 0,
    aiWh, dekodingWh, lesingWh, lesingMin, lesingMaks, harMetode,
    vannL: T && Number(T.vann_l) > 0 ? Number(T.vann_l) : kall * 0.00026,
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

/* Relaterbare enheter.
 *
 * Tokens sier ingenting til noen som ikke jobber med dette. Fire omregninger,
 * alle med oppgitt forutsetning — ingen av dem er pyntet:
 *
 *  · sider og lesetid regnes fra TEGN, ikke fra tokens. Vi lagrer sidas fulle
 *    tegnantall (`raa_tegn`), så det er en direkte måling uten tokenizer-
 *    antakelser i veien.
 *  · vann og energi er per forespørsel, fra samme papir (arXiv:2508.15734).
 */
const TEGN_PER_SIDE = 3000;      // tett A4-side
const TEGN_PER_MINUTT = 1000;    // ~200 ord i minuttet
const ML_VANN_PER_KALL = 0.26;   // Google 2025, median tekstforespørsel
const WH_PER_KALL = 0.24;        // samme papir

function enheter(d) {
  const sider = d.raa_tegn / TEGN_PER_SIDE;
  const lesemin = d.raa_tegn / TEGN_PER_MINUTT;
  const vannMl = d.vannL * 1000;
  const wh = d.aiWh;

  // Timer blir uleselig over et døgn eller to. Døgn er lettere å ta inn.
  const lesetid = lesemin < 90
    ? `${Math.round(lesemin)} min`
    : lesemin < 60 * 48
      ? `${komma(lesemin / 60)} t`
      : `${komma(lesemin / 1440)} døgn`;
  const vann = vannMl < 1000
    ? `${komma(vannMl, 0)} mL`
    : `${komma(vannMl / 1000)} L`;

  // Sider og lesetid beskriver sidene AI-en åpnet, i full størrelse — ikke
  // bare det som fikk plass etter kutt. Etikettene må si det, ellers leses
  // tallene som om de gjaldt det vi faktisk sendte.
  return [
    { tall: sep(sider),        navn: "A4-sider åpnet",          fin: "hele sidene, 3 000 tegn per side" },
    { tall: lesetid,           navn: "å lese dem for et menneske", fin: "~200 ord i minuttet" },
    { tall: vann,              navn: "vann til kjøling",        fin: d.harMetode ? "EcoLogits, kun generering" : "0,26 mL per forespørsel" },
    { tall: komma(wh) + " Wh", navn: "strøm, lesing + svar",    fin: d.harMetode ? `derav lesing ${komma(d.lesingWh)} [${komma(d.lesingMin)}–${komma(d.lesingMaks)}]` : "0,24 Wh per forespørsel" },
  ];
}

/* De siste innleverte målingene. Viser side og tall — aldri studentens egne
 * ord. Handoffen er tydelig: fritekst blir på telefonen. */
function sisteMaalinger() {
  if (!SISTE.length) {
    return `<div style="font-size:17px;color:#5a5a5a">Ingen målinger enda i dag.</div>`;
  }
  return SISTE.slice(0, 6).map((m) => {
    const side = String(m.side).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    const f = m.tokens_reint > 0 ? m.tokens_raa / m.tokens_reint : 0;
    return `<div style="display:flex;align-items:baseline;gap:14px;padding:9px 0;border-bottom:1px solid #1c1c1c">
      <div class="mono" style="font-size:16px;color:#9a9a9a;width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${side}</div>
      <div class="mono" style="font-size:17px;color:#f97316;width:88px;text-align:right">${sep(m.tokens_raa)}</div>
      <div class="mono" style="font-size:15px;color:#4a4a4a">/</div>
      <div class="mono" style="font-size:17px;color:#4ade80;width:62px;text-align:right">${sep(m.tokens_reint)}</div>
      <div class="mono disp" style="font-size:19px;color:#fb923c;margin-left:auto">${f < 10 ? komma(f) : Math.round(f)}×${m.kuttet ? "<span style='font-size:13px;color:#fbbf24'>+</span>" : ""}</div>
    </div>`;
  }).join("");
}

// ───────────────────────────────────────────────────────────────── tegning

function tegn() {
  const d = tallene();
  const e = enheter(d);

  const reintBredde = d.raa > 0 ? Math.max(0.2, (d.reint / d.raa) * 100) : 0;
  const spart = d.raa - d.reint;

  document.getElementById("rot").innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;gap:40px;flex-shrink:0">
    <div class="kol" style="gap:8px">
      <div class="lbl" style="color:#f97316">Energiregnskap · standen i dag</div>
      <div class="disp" style="font-size:46px;font-weight:700;line-height:1">Hva koster det å spørre?</div>
    </div>
    <div style="display:flex;align-items:center;gap:20px;padding:14px 20px;flex-shrink:0" class="kort">
      ${qrMarkup()}
      <div class="kol" style="gap:7px">
        <div class="disp" style="font-size:25px;font-weight:700;line-height:1.1">Skann og prøv selv</div>
        <div style="font-size:15px;color:#9a9a9a;line-height:1.4">Velg en side, still ditt eget<br>spørsmål — omtrent ett minutt</div>
        <div style="display:flex;align-items:center;gap:9px;margin-top:2px">
          <div style="width:9px;height:9px;border-radius:999px;background:#4ade80"></div>
          <div class="mono" style="font-size:14px;color:#9a9a9a">oppdaterer live</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;gap:26px;flex-grow:1;min-height:0">

    <div class="kort kol" style="flex-grow:1;gap:18px;padding:32px;border-color:#3a2412;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="lbl" style="color:#f97316">AI-en har brukt${d.kaldstart ? " · korpus, ikke i dag" : ""}</div>
        ${d.kuttede > 0 ? `<div class="mono" style="font-size:14px;color:#fbbf24">${d.kuttede} av ${d.kall} kall kuttet — gulv</div>` : ""}
      </div>

      <div style="display:flex;align-items:flex-end;gap:34px">
        <div class="kol" style="gap:2px">
          <div style="display:flex;align-items:baseline;gap:11px">
            <div class="mono disp${nytt("raa", d.raa)}" style="font-size:76px;font-weight:500;line-height:0.9;color:#f97316">${sep(d.raa)}</div>
            <div style="font-size:20px;color:#9a9a9a">tokens</div>
          </div>
          <div style="font-size:15px;color:#6b6b6b">slik nettet er i dag</div>
        </div>
        <div class="kol" style="gap:2px;padding-left:30px;border-left:1px solid #282828">
          <div style="display:flex;align-items:baseline;gap:10px">
            <div class="mono disp${nytt("reint", d.reint)}" style="font-size:52px;font-weight:500;line-height:0.9;color:#4ade80">${sep(d.reint)}</div>
            <div style="font-size:18px;color:#9a9a9a">tokens</div>
          </div>
          <div style="font-size:15px;color:#4ade80">om sidene var ren tekst</div>
        </div>
      </div>

      <div class="kol" style="gap:12px">
        <div class="kol" style="gap:7px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:19px;color:#ededed">Alt AI-en måtte lese</span>
            <span class="mono" style="font-size:19px;color:#fb923c">${sep(d.raa)}</span>
          </div>
          <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:100%;height:100%;background:#f97316"></div></div>
        </div>
        <div class="kol" style="gap:7px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:19px;color:#ededed">Selve teksten på siden</span>
            <span class="mono" style="font-size:19px;color:#4ade80">${sep(d.reint)}</span>
          </div>
          <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:${reintBredde}%;min-width:6px;height:100%;background:#4ade80"></div></div>
        </div>
      </div>

      <div style="font-size:15px;color:#6b6b6b;line-height:1.4">Tokens er tekstbitene AI-en leser og betaler for. Omtrent tre bokstaver hver.</div>

      <div style="display:flex;margin-top:auto;padding-top:20px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall${nytt("spm", d.spoersmaal)}">${sep(d.spoersmaal)}</div>
          <div class="statNavn">spørsmål stilt</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall${nytt("spart", spart)}" style="color:#4ade80">${sep(spart)}</div>
          <div class="statNavn">tokens spart</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall${nytt("forhold", Math.round(d.forhold))}" style="color:#fb923c">${d.forhold < 10 ? komma(d.forhold) : sep(d.forhold)}<span style="font-size:21px;color:#9a9a9a">×</span></div>
          <div class="statNavn">mer enn selve teksten${d.kuttede > 0 ? ", minst" : ""}</div>
        </div>
      </div>
    </div>

    <div class="kort kol" style="width:470px;flex-shrink:0;gap:14px;padding:28px 30px">
      <div class="lbl">Siste innleverte</div>
      <div style="display:flex;gap:14px;font-size:13px;color:#5a5a5a;padding-bottom:2px">
        <span style="width:150px">side</span><span style="width:88px;text-align:right">AI-en leste</span>
        <span style="width:12px"></span><span style="width:62px;text-align:right">teksten</span>
        <span style="margin-left:auto">forskjell</span>
      </div>
      <div class="kol" style="min-height:0;overflow:hidden">${sisteMaalinger()}</div>
      <div class="fin" style="margin-top:auto;font-size:13px;color:#5a5a5a;line-height:1.45">
        Spørsmålene blir på telefonene. Her står bare side og tall.${d.kuttede > 0 ? " <span style='color:#fbbf24'>+</span> betyr at siden var for stor og ble kuttet." : ""}
      </div>
    </div>

    <div class="kort kol" style="width:470px;flex-shrink:0;gap:16px;padding:28px 30px;border-color:#3a2412">
      <div class="lbl" style="color:#fb923c">Strøm brukt her</div>
      <div style="display:flex;align-items:baseline;gap:12px">
        <div class="mono disp${nytt("wh", Math.round(d.aiWh * 100))}" style="font-size:64px;font-weight:500;line-height:0.9;color:#fb923c">${komma(d.aiWh)}</div>
        <div style="font-size:20px;color:#9a9a9a">Wh</div>
      </div>
      ${d.harMetode ? `
      <div class="kol" style="gap:11px">
        <div class="kol" style="gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:17px;color:#ededed">Å lese sidene</span>
            <span class="mono" style="font-size:18px;color:#fb923c">${komma(d.lesingWh)} Wh</span>
          </div>
          <div style="height:26px;background:#1c1c1c;border-radius:6px;overflow:hidden"><div style="width:100%;height:100%;background:#f97316"></div></div>
          <div style="font-size:14px;color:#6b6b6b">bånd: ${komma(d.lesingMin)} til ${komma(d.lesingMaks)} Wh</div>
        </div>
        <div class="kol" style="gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:17px;color:#ededed">Å svare</span>
            <span class="mono" style="font-size:18px;color:#4ade80">${komma(d.dekodingWh)} Wh</span>
          </div>
          <div style="height:26px;background:#1c1c1c;border-radius:6px;overflow:hidden"><div style="width:${Math.max(1.2, (d.dekodingWh / Math.max(d.lesingWh, 0.001)) * 100)}%;min-width:5px;height:100%;background:#4ade80"></div></div>
          <div style="font-size:14px;color:#6b6b6b">selve svaret koster lite</div>
        </div>
      </div>` : `
      <div class="kol" style="gap:10px;flex-grow:1;justify-content:center">
        <div style="font-size:17px;color:#5a5a5a;line-height:1.5">Ingen målinger med metode enda.</div>
      </div>`}
      <div style="display:flex;margin-top:auto;padding-top:18px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall" style="color:#fb923c">${d.harMetode && d.dekodingWh > 0 ? Math.round(d.lesingWh / d.dekodingWh) : "—"}<span style="font-size:21px;color:#9a9a9a">×</span></div>
          <div class="statNavn">lesing mot svar</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall">${komma(d.vannL * 1000, 1)}<span style="font-size:21px;color:#9a9a9a"> mL</span></div>
          <div class="statNavn">vann til kjøling</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;gap:26px;flex-shrink:0">
    ${e.map((x) => `<div class="kort kol" style="flex:1;gap:4px;padding:20px 24px;min-width:0">
      <div class="mono disp" style="font-size:34px;font-weight:500;line-height:1;color:#ededed">${x.tall}</div>
      <div style="font-size:16px;color:#9a9a9a;line-height:1.3">${x.navn}</div>
      <div style="font-size:13px;color:#5a5a5a;margin-top:2px">${x.fin}</div>
    </div>`).join("")}
  </div>

  <div style="display:flex;align-items:center;gap:34px;padding:24px 32px;background:#0e0e0e;border:1px solid #282828;border-left:5px solid #fbbf24;border-radius:12px;flex-shrink:0">
    <div class="kol" style="gap:5px;flex-shrink:0">
      <div class="mono disp" style="font-size:50px;font-weight:500;line-height:1;color:#fbbf24">${d.harMetode && d.spoersmaal > 0 ? komma(d.aiWh / d.spoersmaal) : "—"}</div>
      <div style="font-size:17px;color:#9a9a9a">Wh per spørsmål</div>
    </div>
    <div style="width:1px;align-self:stretch;background:#282828"></div>
    <div class="kol" style="gap:6px;flex-grow:1">
      <div style="font-size:20px;color:#ededed;line-height:1.45">Sveiva står ved <span style="color:#4ade80">fellesskjermen</span>. Her måles bare forbruket; der borte lager rommet strøm mot begge stasjonene til sammen.</div>
      <div style="font-size:15px;color:#6b6b6b;line-height:1.5">${d.harMetode
        ? "Strømmen er regnet ut, ikke målt — ingen leverandør oppgir hvor mye ett spørsmål bruker. Vi regner både det å lese siden og det å svare, og lesingen er den klart største posten. Det er nettopp den de vanlige metodene hopper over. Vi oppgir alltid det laveste anslaget. Beregningen bygger på EcoLogits og Epoch AI, og er dokumentert med kilder."
        : "Strømmen er regnet ut, ikke målt: 0,24 Wh per spørsmål, målt av Google i 2025 på en gjennomsnittlig forespørsel. Det laveste anslaget, ikke et gjennomsnitt."}</div>
    </div>
    <div class="kol" style="gap:5px;flex-shrink:0;align-items:flex-end;padding-left:26px;border-left:1px solid #282828">
      <div class="mono" style="font-size:19px;color:${d.brukt / (d.budsjett || 1) > 0.8 ? "#fbbf24" : "#6b6b6b"}">${komma(d.brukt, 2)} / ${komma(d.budsjett, 2)} $</div>
      <div style="font-size:14px;color:#5a5a5a">av dagens budsjett</div>
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
