/* Lagtavla — fellesskjermen for begge stasjonene.
 *
 * Bygget fra Lagtavle.dc.html. Forskjellen fra storskjermen: her er det de to
 * stasjonene mot hverandre på tokensiden, og én felles pott på sveivesiden.
 * Sveiva vet ikke hvem som sveiver, og det står det også på skjermen.
 *
 * Samme datakilder og samme Realtime-kanal som storskjermen.
 */

const db = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const JOULE_PER_SPM = 864;    // 0,24 Wh, etterprøvd mot arXiv:2508.15734
const MAAL_JOULE = 8640;      // ti spørsmål

// Stasjonsnavnene i basen er tekniske; dette er det som står på skjermen.
const NAVN = { halvor: "Halvor", medstudent: "Medstudent" };

let T = null;        // booth_totals
let STASJ = [];      // stasjon_totaler
let LINJE = [];      // tidslinje, kvarter for kvarter
let forrige = {};

const sep = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const komma = (n, d = 1) => (Math.round(Number(n) * 10 ** d) / 10 ** d).toString().replace(".", ",");

function nytt(nokkel, verdi) {
  const endret = forrige[nokkel] !== undefined && forrige[nokkel] !== verdi;
  forrige[nokkel] = verdi;
  return endret ? " puls" : "";
}

async function hent() {
  try {
    const [t, s, b] = await Promise.all([
      db.from("booth_totals").select("*").single(),
      db.from("stasjon_totaler").select("*"),
      db.from("tidslinje").select("*"),
    ]);
    if (t.error) throw t.error;
    T = t.data;
    STASJ = s.data ?? [];
    LINJE = b.data ?? [];
    document.getElementById("frakoblet").classList.remove("vis");
  } catch {
    document.getElementById("frakoblet").classList.add("vis");
  }
  tegn();
}

db.realtime.setAuth();
db.channel("booth", { config: { private: true } })
  .on("broadcast", { event: "endring" }, () => hent())
  .subscribe();
setInterval(hent, 15000);
hent();

/* Stablet arealdiagram: AI-energi brukt, delt i dekket og udekket.
 *
 * Total høyde = kall × 0,24 Wh, akkumulert over dagen. Det grønne båndet er
 * energien rommet faktisk har sveivet inn; det oransje er det som mangler.
 * De to summerer til totalen, så stablingen er meningsbærende — den gjør
 * underskuddet til et areal i stedet for en avstand man må måle.
 *
 * Sveiver rommet inn mer enn AI-en har brukt, kan grønt ikke vokse forbi
 * totalen — da ville diagrammet vist mer forbruk enn det som fant sted. Vi
 * klipper det, og bunnstripa sier fra at dekningen er over hundre.
 */
function arealdiagram(bredde, hoyde) {
  // Slå sammen de to kildene per kvarter og akkumuler.
  const kart = new Map();
  for (const r of LINJE) {
    const t = new Date(r.bolk).getTime();
    const f = kart.get(t) || { t, kall: 0, joules: 0 };
    f.kall += Number(r.kall); f.joules += Number(r.joules);
    kart.set(t, f);
  }
  const punkter = [...kart.values()].sort((a, b) => a.t - b.t);
  if (punkter.length < 2) {
    return `<div style="height:${hoyde}px;display:flex;align-items:center;justify-content:center;color:#5a5a5a;font-size:18px">
      Diagrammet tegner seg når standen har vært i gang en stund.</div>`;
  }

  let kall = 0, joules = 0;
  const serie = punkter.map((p) => {
    kall += p.kall; joules += p.joules;
    return { t: p.t, brukt: kall * 0.24, sveivet: joules / 3600 };  // Wh
  });

  const maks = Math.max(...serie.map((s) => s.brukt), 0.001);
  const P = { v: 62, h: 18, t: 14, b: 26 };            // marger
  const iw = bredde - P.v - P.h, ih = hoyde - P.t - P.b;
  const x = (i) => P.v + (i / (serie.length - 1)) * iw;
  const y = (wh) => P.t + ih - (Math.min(wh, maks) / maks) * ih;

  const topp = serie.map((s, i) => `${x(i)},${y(s.brukt)}`).join(" ");
  const skille = serie.map((s, i) => `${x(i)},${y(Math.min(s.sveivet, s.brukt))}`).join(" ");
  const bunn = `${x(serie.length - 1)},${y(0)} ${x(0)},${y(0)}`;

  // Rutenett med Wh-verdier, så arealene kan leses som tall og ikke bare form.
  const linjer = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const wh = maks * f;
    return `<line x1="${P.v}" y1="${y(wh)}" x2="${bredde - P.h}" y2="${y(wh)}" stroke="#1c1c1c" stroke-width="1"/>
      <text x="${P.v - 9}" y="${y(wh) + 5}" text-anchor="end" fill="#5a5a5a" font-size="13"
        font-family="IBM Plex Mono, monospace">${komma(wh, wh < 10 ? 1 : 0)}</text>`;
  }).join("");

  const klokke = (ms) => new Date(ms).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });

  return `<svg viewBox="0 0 ${bredde} ${hoyde}" width="100%" height="${hoyde}"
      preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Stablet areal: AI-energi brukt, delt i dekket av sveiving og udekket">
    ${linjer}
    <polygon points="${skille} ${topp.split(" ").reverse().join(" ")}" fill="#f97316" fill-opacity="0.85"/>
    <polygon points="${skille} ${bunn}" fill="#4ade80" fill-opacity="0.9"/>
    <polyline points="${topp}" fill="none" stroke="#fb923c" stroke-width="2"/>
    <polyline points="${skille}" fill="none" stroke="#86efac" stroke-width="2"/>
    <text x="${P.v}" y="${hoyde - 7}" fill="#5a5a5a" font-size="13" font-family="IBM Plex Mono, monospace">${klokke(serie[0].t)}</text>
    <text x="${bredde - P.h}" y="${hoyde - 7}" text-anchor="end" fill="#5a5a5a" font-size="13" font-family="IBM Plex Mono, monospace">${klokke(serie[serie.length - 1].t)}</text>
    <text x="${P.v - 9}" y="${P.t - 2}" text-anchor="end" fill="#5a5a5a" font-size="12" font-family="IBM Plex Sans, sans-serif">Wh</text>
  </svg>`;
}

function tegn() {
  const kall = T ? Number(T.kall) : 0;
  const joules = T ? Number(T.joules) : 0;
  const wh = joules / 3600;
  const aiWh = kall * 0.24;
  const dekning = aiWh > 0 ? (wh / aiWh) * 100 : 0;

  // Målet fylles opp på nytt for hver runde på ti spørsmål.
  const iRunden = joules % MAAL_JOULE;
  const mangler = Math.max(0, MAAL_JOULE - iRunden);
  const andel = Math.min(100, (iRunden / MAAL_JOULE) * 100);
  // ~40 W er det en person klarer å holde på en håndsveiv over tid.
  const sek = Math.round(mangler / 40);

  // Begge stasjonene vises alltid, også før den ene har fått noen innom —
  // en tom rad er et ærligere bilde enn en skjult.
  const rader = ["halvor", "medstudent"].map((id) => {
    const r = STASJ.find((x) => x.stasjon === id);
    return { navn: NAVN[id], tokens: r ? Number(r.tokens_raa) : 0, spm: r ? Number(r.spoersmaal) : 0 };
  });
  const total = rader.reduce((a, r) => a + r.tokens, 0);
  const maksRad = Math.max(...rader.map((r) => r.tokens), 1);

  const stolper = rader.map((r, i) => `
    <div class="kol" style="gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:21px;color:#ededed">${r.navn}</span>
        <span class="mono" style="font-size:20px;color:#fb923c">${sep(r.tokens)}<span style="font-size:15px;color:#6b6b6b"> · ${r.spm} spm</span></span>
      </div>
      <div style="height:34px;background:#1c1c1c;border-radius:6px;overflow:hidden">
        <div style="width:${(r.tokens / maksRad) * 100}%;height:100%;background:${i === 0 ? "#f97316" : "#c2540f"}"></div>
      </div>
    </div>`).join("");

  document.getElementById("rot").innerHTML = `
  <div class="kol" style="gap:9px;align-items:center;flex-shrink:0">
    <div class="lbl" style="color:#4ade80;font-size:15px">Rommet mot AI-en</div>
    <div class="disp" style="font-size:46px;font-weight:700;line-height:1;text-align:center">Klarer dere å sveive inn like mye som vi bruker?</div>
  </div>

  <div class="kol" style="gap:12px;padding:22px 36px;background:#111;border:1px solid #282828;border-radius:16px;flex-shrink:0">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <span style="font-size:22px;color:#ededed">Neste mål — strøm nok til ti spørsmål</span>
      <span class="mono disp${nytt("iRunden", Math.round(iRunden))}" style="font-size:30px;font-weight:500;color:#4ade80">${sep(iRunden)} <span style="font-size:20px;color:#6b6b6b">/ ${sep(MAAL_JOULE)} J</span></span>
    </div>
    <div style="height:44px;background:#1c1c1c;border-radius:10px;overflow:hidden">
      <div style="width:${andel}%;height:100%;background:#4ade80;border-radius:10px;transition:width .6s ease-out"></div>
    </div>
    <div style="display:flex;justify-content:space-between">
      <span style="font-size:17px;color:#9a9a9a">Dere mangler ${sep(mangler)} joule</span>
      <span style="font-size:17px;color:#9a9a9a">omtrent ${sek > 90 ? komma(sek / 60, 0) + " minutter" : sek + " sekunder"} til på sveiva</span>
    </div>
  </div>

  <div style="display:flex;gap:26px;flex-grow:1;min-height:0">

    <div class="kort kol" style="flex-grow:1;gap:14px;padding:26px 30px;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="lbl" style="font-size:15px">Energi gjennom dagen</div>
        <div style="display:flex;gap:22px;align-items:center">
          <div style="display:flex;align-items:center;gap:9px">
            <div style="width:13px;height:13px;border-radius:3px;background:#4ade80"></div>
            <span style="font-size:16px;color:#cfcfcf">sveivet inn</span>
          </div>
          <div style="display:flex;align-items:center;gap:9px">
            <div style="width:13px;height:13px;border-radius:3px;background:#f97316"></div>
            <span style="font-size:16px;color:#cfcfcf">ikke dekket</span>
          </div>
        </div>
      </div>
      ${arealdiagram(1166, 300)}
      <div style="font-size:15px;color:#6b6b6b;line-height:1.5;margin-top:-4px">
        Hele høyden er strømmen spørsmålene har brukt. Det grønne er det rommet
        har laget selv — resten er kjøpt.
      </div>
      <div style="display:flex;margin-top:auto;padding-top:18px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall${nytt("joules", joules)}" style="color:#4ade80">${sep(joules)}</div>
          <div class="statNavn">joule i potten</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall${nytt("oekter", T ? T.sveiveoekter : 0)}">${sep(T ? T.sveiveoekter : 0)}</div>
          <div class="statNavn">sveiveøkter</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall">${komma(wh)}<span style="font-size:20px;color:#9a9a9a"> Wh</span></div>
          <div class="statNavn">sveivet, samlet</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall" style="color:#fb923c">${komma(aiWh)}<span style="font-size:20px;color:#9a9a9a"> Wh</span></div>
          <div class="statNavn">brukt, antatt gulv</div>
        </div>
      </div>
    </div>

    <div class="kort kol" style="width:540px;flex-shrink:0;gap:16px;padding:26px 30px;border-color:#3a2412">
      <div class="lbl" style="color:#f97316;font-size:15px">Tokens brukt — begge stasjonene</div>
      <div class="mono disp${nytt("total", total)}" style="font-size:58px;font-weight:500;line-height:0.92;color:#f97316">${sep(total)}</div>
      <div class="kol" style="gap:15px;margin-top:2px">${stolper}</div>
      <div style="font-size:16px;color:#cfcfcf;line-height:1.5;margin-top:6px">
        Sveiva vet ikke hvem som sveiver. Alt går i samme pott — den er lagets,
        ikke stasjonens.
      </div>
      <div style="display:flex;margin-top:auto;padding-top:18px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall">${sep(T ? T.spoersmaal : 0)}</div>
          <div class="statNavn">spørsmål</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall">${sep(kall)}</div>
          <div class="statNavn">kall til modellen</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:30px;padding:20px 32px;background:#0e0e0e;border:1px solid #282828;border-left:5px solid #fbbf24;border-radius:12px;flex-shrink:0">
    <div class="mono disp" style="font-size:48px;font-weight:500;line-height:1;color:#fbbf24;flex-shrink:0">${dekning > 0 && dekning < 1 ? komma(dekning) : Math.round(dekning)} %</div>
    <div class="kol" style="gap:5px;flex-grow:1">
      <div style="font-size:20px;color:#ededed;line-height:1.45">${
        dekning >= 100
          ? "Dere har sveivet inn mer enn spørsmålene brukte. Det har ingen klart før."
          : "Hele dagens sveiving dekker " + (dekning < 20 ? "under en femtedel" : dekning < 34 ? "under en tredjedel" : dekning < 51 ? "under halvparten" : "over halvparten") + " av strømmen spørsmålene brukte."
      }</div>
      <div style="font-size:15px;color:#6b6b6b;line-height:1.5">Omregning: 0,24 Wh per forespørsel (Google, 2025 — median tekstforespørsel), et gulv og ikke et estimat. Det svakeste tallet på skjermen, og det står her for å kunne bestrides.</div>
    </div>
  </div>`;
}

function skaler() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  const scene = document.getElementById("scene");
  const rot = document.getElementById("rot");
  rot.style.transformOrigin = "top left";
  rot.style.transform = `scale(${s})`;
  scene.style.width = Math.round(1920 * s) + "px";
  scene.style.height = Math.round(1080 * s) + "px";
}
new ResizeObserver(skaler).observe(document.documentElement);
addEventListener("resize", skaler);
addEventListener("load", skaler);
skaler();
