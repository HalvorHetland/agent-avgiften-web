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
const MOBIL_WH = 12;          // et mobilbatteri, som i designet
const GLASS_ML = 200;         // et glass vann

let T = null;        // booth_totals
let LINJE = [];      // tidslinje, kvarter for kvarter
/* Felles energipott: Gjermunds `event_totals`, som begge stasjonene legger inn
 * i via `increment_totals`. Dette er tallet lagtavla skal vise. */
let FELLES = null;
let FORLOEP = [];    // felles pott gjennom dagen, logget ved hver endring
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
    const [t, b, f, h] = await Promise.all([
      db.from("booth_totals").select("*").single(),
      db.from("tidslinje").select("*"),
      db.from("energi_forloep").select("*"),
      db.from("event_totals").select("*").maybeSingle(),
    ]);
    if (t.error) throw t.error;
    T = t.data;
    LINJE = b.data ?? [];
    FELLES = f.data ?? null;
    FORLOEP = h.data ?? [];
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
  // Den oransje kurven er den FELLES potten, logget ved hver endring — både
  // våre kall og Gjermunds chatbot-økter. Den grønne er sveivet energi,
  // akkumulert fra crank_runs. Begge i Wh, som er poenget: nå deler vi enhet.
  if (FORLOEP.length < 2) {
    return `<div style="height:${hoyde}px;display:flex;align-items:center;justify-content:center;color:#5a5a5a;font-size:18px">
      Diagrammet tegner seg når standen har vært i gang en stund.</div>`;
  }

  // Sveiving per kvarter, akkumulert, som oppslag på tid.
  const sveiv = [];
  let sum = 0;
  for (const r of [...LINJE].sort((a, b) => new Date(a.bolk) - new Date(b.bolk))) {
    sum += Number(r.joules) / 3600;                       // joule -> Wh
    sveiv.push({ t: new Date(r.bolk).getTime(), wh: sum });
  }
  const sveivetVed = (t) => {
    let v = 0;
    for (const p of sveiv) { if (p.t <= t) v = p.wh; else break; }
    return v;
  };

  const serie = FORLOEP.map((r) => {
    const t = new Date(r.t).getTime();
    return { t, brukt: Number(r.total_energy_wh), sveivet: sveivetVed(t) };
  });
  const harSveiv = serie.some((p) => p.sveivet > 0);

  const maks = Math.max(...serie.map((s) => s.brukt), 0.001);
  const P = { v: 62, h: 18, t: 14, b: 26 };
  const iw = bredde - P.v - P.h, ih = hoyde - P.t - P.b;
  // Tidsakse, ikke jevne steg: loggen kommer ujevnt, og en jevn akse ville
  // strukket rolige perioder like brede som travle.
  const t0 = serie[0].t, t1 = serie[serie.length - 1].t;
  const spenn = Math.max(1, t1 - t0);
  const x = (t) => P.v + ((t - t0) / spenn) * iw;
  const y = (wh) => P.t + ih - (Math.min(wh, maks) / maks) * ih;

  const topp = serie.map((s) => `${x(s.t)},${y(s.brukt)}`).join(" ");
  const skille = serie.map((s) => `${x(s.t)},${y(Math.min(s.sveivet, s.brukt))}`).join(" ");
  const bunn = `${x(t1)},${y(0)} ${x(t0)},${y(0)}`;

  const linjer = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const wh = maks * f;
    return `<line x1="${P.v}" y1="${y(wh)}" x2="${bredde - P.h}" y2="${y(wh)}" stroke="#1c1c1c" stroke-width="1"/>
      <text x="${P.v - 9}" y="${y(wh) + 5}" text-anchor="end" fill="#5a5a5a" font-size="13"
        font-family="IBM Plex Mono, monospace">${komma(wh, wh < 10 ? 1 : 0)}</text>`;
  }).join("");

  const klokke = (ms) => new Date(ms).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });

  return `<svg viewBox="0 0 ${bredde} ${hoyde}" width="100%" height="${hoyde}"
      preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Stablet areal: felles AI-energi, delt i dekket av sveiving og udekket">
    ${linjer}
    <polygon points="${skille} ${topp.split(" ").reverse().join(" ")}" fill="#f97316" fill-opacity="0.85"/>
    <polygon points="${skille} ${bunn}" fill="#4ade80" fill-opacity="0.9"/>
    <polyline points="${topp}" fill="none" stroke="#fb923c" stroke-width="2"/>
    ${harSveiv ? `<polyline points="${skille}" fill="none" stroke="#86efac" stroke-width="2"/>` : ""}
    <text x="${P.v}" y="${hoyde - 7}" fill="#5a5a5a" font-size="13" font-family="IBM Plex Mono, monospace">${klokke(t0)}</text>
    <text x="${bredde - P.h}" y="${hoyde - 7}" text-anchor="end" fill="#5a5a5a" font-size="13" font-family="IBM Plex Mono, monospace">${klokke(t1)}</text>
    <text x="${P.v - 9}" y="${P.t - 2}" text-anchor="end" fill="#5a5a5a" font-size="12" font-family="IBM Plex Sans, sans-serif">Wh</text>
    ${harSveiv ? "" : `<text x="${P.v + 16}" y="${P.t + ih / 2}" fill="#6b6b6b" font-size="17"
      font-family="IBM Plex Sans, sans-serif">Grønt bånd kommer når sveiva er koblet til</text>`}
  </svg>`;
}

function tegn() {
  const kall = T ? Number(T.kall) : 0;
  const joules = T ? Number(T.joules) : 0;
  const wh = joules / 3600;
  // Felles pott når den finnes; ellers vår egen andel. Potten dekker begge
  // stasjonene, og det er den lagtavla handler om.
  const aiWh = FELLES ? Number(FELLES.total_energy_wh) : kall * 0.24;
  const vannL = FELLES ? Number(FELLES.total_water_l) : kall * 0.00026;

  /* Del potten på de to stasjonene.
   *
   * Vår andel er eksakt: Edge-funksjonen legger inn 0,24 Wh per kall, og
   * `kall` er antall rader i ai_runs. Resten er Gjermunds — han sender sine
   * EcoLogits-summer inn i den samme potten fra chatbot-eksperimentet sitt.
   *
   * De to andelene er regnet med hver sin metode. Det står på skjermen; å
   * skjule det ville gjort tallet penere og mindre sant. */
  const vaarWh = kall * 0.24;
  const hansWh = Math.max(0, aiWh - vaarWh);
  const maksWh = Math.max(vaarWh, hansWh, 0.001);
  const dekning = aiWh > 0 ? (wh / aiWh) * 100 : 0;
  // Sveivehalvdelen bygges av Gjermund. Før den skriver til crank_runs skal
  // skjermen si at tallet mangler, ikke vise 0 % som om rommet hadde sveivet.
  const ingenSveiv = !T || Number(T.sveiveoekter) === 0;

  // Målet fylles opp på nytt for hver runde på ti spørsmål.
  const iRunden = joules % MAAL_JOULE;
  const mangler = Math.max(0, MAAL_JOULE - iRunden);
  const andel = Math.min(100, (iRunden / MAAL_JOULE) * 100);
  // ~40 W er det en person klarer å holde på en håndsveiv over tid.
  const sek = Math.round(mangler / 40);


  document.getElementById("rot").innerHTML = `
  <div class="kol" style="gap:9px;align-items:center;flex-shrink:0">
    <div class="lbl" style="color:#4ade80;font-size:15px">Rommet mot AI-en</div>
    <div class="disp" style="font-size:46px;font-weight:700;line-height:1;text-align:center">Klarer dere å sveive inn like mye som vi bruker?</div>
  </div>

  <div class="kol" style="gap:12px;padding:22px 36px;background:#111;border:1px solid #282828;border-radius:16px;flex-shrink:0;display:${ingenSveiv ? "none" : "flex"}">
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
        har laget selv — resten er kjøpt.${FELLES ? " Kurven er den felles potten — begge stasjonene." : ""}
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
          <div class="mono disp statTall${nytt("aiWh", Math.round(aiWh * 10))}" style="color:#fb923c">${komma(aiWh)}<span style="font-size:20px;color:#9a9a9a"> Wh</span></div>
          <div class="statNavn">brukt${FELLES ? " — felles pott" : ", antatt gulv"}</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall" style="color:#fb923c">${komma(vannL * 1000, 0)}<span style="font-size:20px;color:#9a9a9a"> mL</span></div>
          <div class="statNavn">vann til kjøling</div>
        </div>
      </div>
    </div>

    <div class="kort kol" style="width:540px;flex-shrink:0;gap:16px;padding:26px 30px;border-color:#3a2412">
      <div class="lbl" style="color:#f97316;font-size:15px">Energi brukt — begge stasjonene</div>
      <div style="display:flex;align-items:baseline;gap:12px">
        <div class="mono disp${nytt("aiWh", Math.round(aiWh * 100))}" style="font-size:58px;font-weight:500;line-height:0.92;color:#f97316">${komma(aiWh, 1)}</div>
        <div style="font-size:20px;color:#9a9a9a">Wh</div>
      </div>

      <div class="kol" style="gap:14px;margin-top:2px">
        <div class="kol" style="gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:20px;color:#ededed">Halvor <span style="font-size:15px;color:#6b6b6b">— nettsidelesing</span></span>
            <span class="mono" style="font-size:20px;color:#fb923c">${komma(vaarWh, 2)} Wh</span>
          </div>
          <div style="height:30px;background:#1c1c1c;border-radius:6px;overflow:hidden">
            <div style="width:${(vaarWh / maksWh) * 100}%;height:100%;background:#f97316"></div>
          </div>
        </div>
        <div class="kol" style="gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:20px;color:#ededed">Gjermund <span style="font-size:15px;color:#6b6b6b">— chatbot</span></span>
            <span class="mono" style="font-size:20px;color:#a78bfa">${komma(hansWh, 2)} Wh</span>
          </div>
          <div style="height:30px;background:#1c1c1c;border-radius:6px;overflow:hidden">
            <div style="width:${(hansWh / maksWh) * 100}%;height:100%;background:#a78bfa"></div>
          </div>
        </div>
      </div>

      <div style="font-size:14px;color:#5a5a5a;line-height:1.45;margin-top:2px">
        Halvor: 0,24 Wh per forespørsel (Google 2025). Gjermund: EcoLogits på
        gpt-5. To metoder — summen er et anslag, ikke én måling.
      </div>

      <div style="display:flex;margin-top:auto;padding-top:18px;border-top:1px solid #282828">
        <div class="stat">
          <div class="mono disp statTall">${komma(aiWh / MOBIL_WH, 1)}</div>
          <div class="statNavn">mobilladinger</div>
        </div>
        <div class="stat">
          <div class="mono disp statTall">${komma(vannL * 1000, 0)}<span style="font-size:20px;color:#9a9a9a"> mL</span></div>
          <div class="statNavn">vann, ${komma((vannL * 1000) / GLASS_ML, 1)} glass</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:30px;padding:20px 32px;background:#0e0e0e;border:1px solid #282828;border-left:5px solid #fbbf24;border-radius:12px;flex-shrink:0">
    <div class="mono disp" style="font-size:48px;font-weight:500;line-height:1;color:${ingenSveiv ? "#5a5a5a" : "#fbbf24"};flex-shrink:0">${ingenSveiv ? "—" : (dekning > 0 && dekning < 1 ? komma(dekning) : Math.round(dekning)) + " %"}</div>
    <div class="kol" style="gap:5px;flex-grow:1">
      <div style="font-size:20px;color:#ededed;line-height:1.45">${
        ingenSveiv
          ? "Sveiva er ikke koblet til enda. Tokentallene er ekte målinger; dekningen kommer når sveivesiden skriver til crank_runs."
        : dekning >= 100
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
