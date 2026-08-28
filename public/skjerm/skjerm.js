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
let SVEIV = [];      // siste tolv sveiveøkter
let SISTE = [];      // siste innleverte målinger
/* Felles energipott med Gjermund. Begge stasjonene legger inn via hans
 * `increment_totals`, så dette er tallet begge skjermene skal vise — ellers
 * gir de to svar på det samme spørsmålet. */
let FELLES = null;
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
    const [t, s, m, f] = await Promise.all([
      db.from("booth_totals").select("*").single(),
      db.from("siste_sveiv").select("*"),
      db.from("siste_maalinger").select("*"),
      db.from("event_totals").select("*").maybeSingle(),
    ]);
    if (t.error) throw t.error;
    T = t.data;
    SVEIV = s.data ?? [];
    SISTE = m.data ?? [];
    FELLES = f.data ?? null;
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
  // Nevneren er den felles potten når den finnes: den dekker begge stasjonene,
  // ikke bare det vi har logget her.
  const aiWh = FELLES ? Number(FELLES.total_energy_wh) : kall * 0.24;
  const aiJoule = aiWh * 3600;
  const dekning = aiJoule > 0 ? (joules / aiJoule) * 100 : 0;
  const mangler = Math.max(0, MAAL_JOULE - (joules % MAAL_JOULE));

  return {
    kaldstart, raa, reint, forhold, kall, joules, wh, dekning, mangler,
    spoersmaal: T ? Number(T.spoersmaal) : 0,
    sveiveoekter: T ? Number(T.sveiveoekter) : 0,
    kuttede: T ? Number(T.kuttede_kall) : 0,
    raa_tegn: T ? Number(T.raa_tegn) : 0,
    // Sveivehalvdelen bygges av medstudenten. Før den finnes skal skjermen si
    // det, ikke vise 0 J og 0 % som om rommet hadde sveivet og fått ingenting.
    ingenSveiv: !T || Number(T.sveiveoekter) === 0,
    aiWh,
    vannL: FELLES ? Number(FELLES.total_water_l) : kall * 0.00026,
    felles: Boolean(FELLES),
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
    { tall: vann,              navn: "vann til kjøling",        fin: d.felles ? "begge stasjonene" : "0,26 mL per forespørsel" },
    { tall: komma(wh) + " Wh", navn: "strøm, som gulv",         fin: d.felles ? "begge stasjonene, felles pott" : "0,24 Wh per forespørsel" },
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

  const soyler = (() => {
    const tom = `<div style="flex-grow:1;border-radius:3px;height:4%;background:#1a1a1a"></div>`;
    if (!SVEIV.length) return tom.repeat(12);
    const maks = Math.max(...SVEIV.map((s) => Number(s.joules)), 1);
    const rekke = [...SVEIV].reverse();   // eldst til venstre, som en tidslinje
    return tom.repeat(Math.max(0, 12 - rekke.length)) + rekke.map((s) => {
      const h = Math.max(6, (Number(s.joules) / maks) * 100);
      const c = h > 85 ? "#4ade80" : (h > 60 ? "#2b5233" : "#1e3a24");
      return `<div style="flex-grow:1;border-radius:3px;height:${h}%;background:${c}"></div>`;
    }).join("");
  })();

  const siste = SVEIV[0];
  const sisteTekst = siste
    ? `${sep(siste.joules)} J${siste.peak_watts ? " · " + komma(siste.peak_watts, 0) + " W topp" : ""}`
    : "ingen enda";

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
          <div style="font-size:15px;color:#4ade80">med min løsning</div>
        </div>
      </div>

      <div class="kol" style="gap:12px">
        <div class="kol" style="gap:7px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:19px;color:#ededed">Hele siden slik den er kodet</span>
            <span class="mono" style="font-size:19px;color:#fb923c">${sep(d.raa)}</span>
          </div>
          <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:100%;height:100%;background:#f97316"></div></div>
        </div>
        <div class="kol" style="gap:7px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:19px;color:#ededed">Bare teksten på siden</span>
            <span class="mono" style="font-size:19px;color:#4ade80">${sep(d.reint)}</span>
          </div>
          <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:${reintBredde}%;min-width:6px;height:100%;background:#4ade80"></div></div>
        </div>
      </div>

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
          <div class="statNavn">dyrere enn nødvendig${d.kuttede > 0 ? ", minst" : ""}</div>
        </div>
      </div>
    </div>

    <div class="kort kol" style="width:470px;flex-shrink:0;gap:14px;padding:28px 30px">
      <div class="lbl">Siste innleverte</div>
      <div style="display:flex;gap:14px;font-size:13px;color:#5a5a5a;padding-bottom:2px">
        <span style="width:150px">side</span><span style="width:88px;text-align:right">kodet</span>
        <span style="width:12px"></span><span style="width:62px;text-align:right">tekst</span>
        <span style="margin-left:auto">forskjell</span>
      </div>
      <div class="kol" style="min-height:0;overflow:hidden">${sisteMaalinger()}</div>
      <div class="fin" style="margin-top:auto;font-size:13px;color:#5a5a5a;line-height:1.45">
        Spørsmålene blir på telefonene. Her står bare side og tall.${d.kuttede > 0 ? " <span style='color:#fbbf24'>+</span> betyr at siden var for stor og ble kuttet." : ""}
      </div>
    </div>

    <div class="kort kol" style="width:470px;flex-shrink:0;gap:16px;padding:28px 30px;border-color:#1e3a24">
      <div class="lbl" style="color:#4ade80">${d.ingenSveiv ? "Sveiva" : "Dere har sveivet"}</div>
      ${d.ingenSveiv ? `
      <div class="kol" style="gap:10px;flex-grow:1;justify-content:center">
        <div class="disp" style="font-size:30px;font-weight:700;line-height:1.15;color:#6b6b6b">Ikke koblet til enda</div>
        <div style="font-size:17px;color:#5a5a5a;line-height:1.5">Denne halvdelen bygges nå. Her kommer joulene rommet lager for hånd, i sanntid.</div>
        <div class="fin" style="font-size:14px;color:#4a4a4a;margin-top:6px">Vi viser ikke et tall vi ikke har målt.</div>
      </div>` : `
      <div style="display:flex;align-items:baseline;gap:12px">
        <div class="mono disp${nytt("joules", d.joules)}" style="font-size:64px;font-weight:500;line-height:0.9;color:#4ade80">${sep(d.joules)}</div>
        <div style="font-size:20px;color:#9a9a9a">joule</div>
      </div>`}
      <div class="kol" style="gap:10px;display:${d.ingenSveiv ? "none" : "flex"}">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:17px;color:#9a9a9a">Siste økt</span>
          <span class="mono" style="font-size:17px">${sisteTekst}</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:5px;height:104px">${soyler}</div>
        <div style="font-size:15px;color:#6b6b6b">siste tolv økter</div>
      </div>
      <div style="display:${d.ingenSveiv ? "none" : "flex"};margin-top:auto;padding-top:18px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall${nytt("oekter", d.sveiveoekter)}">${sep(d.sveiveoekter)}</div>
          <div class="statNavn">som har sveivet</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall">${komma(d.wh)}<span style="font-size:21px;color:#9a9a9a"> Wh</span></div>
          <div class="statNavn">samlet</div>
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
      <div class="mono disp" style="font-size:50px;font-weight:500;line-height:1;color:${d.ingenSveiv ? "#5a5a5a" : "#fbbf24"}">${d.ingenSveiv ? "—" : (d.dekning > 0 && d.dekning < 1 ? komma(d.dekning) : Math.round(d.dekning)) + " %"}</div>
      <div style="font-size:17px;color:#9a9a9a">av strømmen er sveivet inn</div>
    </div>
    <div style="width:1px;align-self:stretch;background:#282828"></div>
    <div class="kol" style="gap:6px;flex-grow:1">
      <div style="font-size:20px;color:#ededed;line-height:1.45">${d.ingenSveiv
        ? "Sveiva er ikke koblet til enda, så dekningen er ikke målt. Tokentallene til venstre er ekte."
        : `Neste mål: <span class="mono" style="color:#4ade80">8 640 J</span> — nok til de ti neste spørsmålene. Dere mangler <span class="mono" style="color:#fbbf24">${sep(d.mangler)} J</span>.`}</div>
      <div style="font-size:15px;color:#6b6b6b;line-height:1.5">Omregning: 0,24 Wh per forespørsel (Google, 2025 — median tekstforespørsel). Våre råe spørsmål er mye større enn en median forespørsel, så dette er et gulv, ikke et estimat.</div>
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
