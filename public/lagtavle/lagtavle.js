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

/* Referanseverdiene leses fra basen, ikke hardkodes.
 *
 * 12 Wh sto i designfila og var aldri etterprøvd — det er kapasiteten til en
 * eldre telefon, ikke energien en full lading trekker fra veggen. Gjermunds
 * eksperiment brukte 11,0 for den samme sammenligningen, og hos ham avgjør
 * verdien om en gjetning regnes som riktig. To utstillinger på samme event kan
 * ikke oppgi to ulike svar på hvor mye en telefonlading er.
 *
 * Standardverdiene under gjelder bare til første henting. */
let MOBIL_WH = 16;
let GLASS_ML = 200;
let KROPP_W = 250;   // anslaatt metabolsk effekt under lett armsveiving, fra innstillinger

let T = null;        // booth_totals
/* Felles energipott: Gjermunds `event_totals`, som begge stasjonene legger inn
 * i via `increment_totals`. Dette er tallet lagtavla skal vise. */
let FELLES = null;
let forrige = {};

const sep = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const komma = (n, d = 1) => (Math.round(Number(n) * 10 ** d) / 10 ** d).toString().replace(".", ",");
// Sveiva gir mikrowattimer per oekt; «0 mWh» sier at ingenting skjedde, og det er usant.
/* Alltid W og Wh — med saa mange desimaler som trengs for to gjeldende sifre.
 * «0,004 W» sier studentene noe; «4 mW» gjoer det ikke. */
const desimaler = (x) => x >= 10 ? 1 : x >= 1 ? 2 : Math.min(6, Math.ceil(-Math.log10(Math.max(x, 1e-7))) + 1);
const wattTekst = (w) => w > 0 ? `${komma(w, desimaler(w))} W` : "0 W";
const whTekst = (x) => x > 0 ? `${komma(x, desimaler(x))} Wh` : "0 Wh";
const tidTekst = (sek) => sek > 63072000 ? `${komma(sek / 31536000, 1)} år` : sek > 5184000 ? `${komma(sek / 2592000, 0)} måneder` : sek > 172800 ? `${komma(sek / 86400, 0)} døgn` : sek > 7200 ? `${komma(sek / 3600, 1)} timer` : sek > 90 ? `${komma(sek / 60, 0)} minutter` : `${komma(sek, 0)} sekunder`;
const lengde = (mm) => mm < 10 ? `${komma(mm, 1)} millimeter` : mm < 1000 ? `${komma(mm / 10, 0)} centimeter` : mm < 1e7 ? `${komma(mm / 1000, 0)} meter` : `${komma(mm / 1e6, 1)} kilometer`;

function nytt(nokkel, verdi) {
  const endret = forrige[nokkel] !== undefined && forrige[nokkel] !== verdi;
  forrige[nokkel] = verdi;
  return endret ? " puls" : "";
}

async function hent() {
  try {
    // Navngitte felt, ikke posisjon: en ny spørring satt inn midt i lista
    // byttet om FELLES og FORLOEP forrige gang, og skjermen ble svart.
    const svar = Object.fromEntries(await Promise.all(
      [
        ["totaler", db.from("booth_totals").select("*").single()],
        ["felles", db.from("event_totals").select("*").maybeSingle()],
        ["konstanter", db.from("konstanter").select("*")],
      ].map(async ([navn, q]) => [navn, await q]),
    ));

    if (svar.totaler.error) throw svar.totaler.error;
    T = svar.totaler.data;
    FELLES = svar.felles.data ?? null;
    for (const k of svar.konstanter.data ?? []) {
      if (k.noekkel === "mobil_wh") MOBIL_WH = Number(k.verdi);
      if (k.noekkel === "glass_ml") GLASS_ML = Number(k.verdi);
      if (k.noekkel === "kropp_w_sveiv") KROPP_W = Number(k.verdi);
    }
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

let PULS = null;   // siste puls fra brua: { watt, sek, joule, alder_s }
async function hentPuls() {
  try {
    const r = await db.from("sveiv_naa").select("*").maybeSingle();
    PULS = r.data ?? null;
  } catch { PULS = null; }
  tegnPuls();
}
setInterval(hentPuls, 2000);
hentPuls();

/* Naa-panelet tegnes for seg, hvert 2. sekund, uten aa tegne hele tavla. */
function tegnPuls() {
  const el = document.getElementById("naa");
  if (!el) return;
  const fersk = PULS && Number(PULS.alder_s) < 6;
  el.innerHTML = fersk ? `
    <div style="display:flex;align-items:baseline;gap:14px">
      <div class="mono disp" style="font-size:64px;font-weight:500;line-height:0.9;color:#4ade80">${komma(Number(PULS.watt), desimaler(Number(PULS.watt)))}</div>
      <div style="font-size:22px;color:#9a9a9a">W akkurat nå</div>
      <div style="width:14px;height:14px;border-radius:50%;background:#4ade80;margin-left:auto;animation:puls 1s ease-in-out infinite"></div>
    </div>
    <div style="display:flex;gap:34px;margin-top:14px">
      <div class="kol" style="gap:3px"><div class="mono disp" style="font-size:30px;color:#ededed">${komma(Number(PULS.sek), 0)} s</div><div style="font-size:14px;color:#8a8a8a">denne økta</div></div>
      <div class="kol" style="gap:3px"><div class="mono disp" style="font-size:30px;color:#ededed">${komma(Number(PULS.joule), 2)} J</div><div style="font-size:14px;color:#8a8a8a">= ${whTekst(Number(PULS.joule) / 3600)}</div></div>
    </div>` : `
    <div class="kol" style="gap:8px;justify-content:center;flex-grow:1">
      <div class="disp" style="font-size:30px;font-weight:700;color:#767676">Sveiva står stille</div>
      <div style="font-size:17px;color:#8a8a8a;line-height:1.5">Ta i, så våkner tallet her. Hver økt måles: volt ganger ampere ganger tid.</div>
    </div>`;
}

function tegn() {
  const kall = T ? Number(T.kall) : 0;
  const joules = T ? Number(T.joules) : 0;
  const wh = joules / 3600;                                     // sveivet inn, Wh, maalt
  const aiWh = FELLES ? Number(FELLES.total_energy_wh) : (T ? Number(T.dekoding_wh) + Number(T.lesing_wh) : 0);
  const vannL = FELLES ? Number(FELLES.total_water_l) : (T ? Number(T.vann_l) : 0);
  const vaarWh = T ? Number(T.dekoding_wh) + Number(T.lesing_wh) : 0;
  const vaarLesing = T ? Number(T.lesing_wh) : 0;
  const hansWh = Math.max(0, aiWh - vaarWh);
  const maksWh = Math.max(vaarWh, hansWh, 0.001);
  const ingenSveiv = !T || Number(T.sveiveoekter) === 0;

  // Ett spoersmaal: dagens maalte snitt paa Halvors stasjon (lesing + svar).
  const spmSnittWh = (T && Number(T.spoersmaal) > 0) ? vaarWh / Number(T.spoersmaal) : 0;
  const sveivS = T ? Number(T.sveiv_ms || 0) / 1000 : 0;
  const maaltW = sveivS > 5 ? joules / sveivS : 0;               // maalt sveiveeffekt, J/s
  const kroppWh = KROPP_W * sveivS / 3600, kroppKcal = kroppWh * 0.86;
  const spmS = maaltW > 0 && spmSnittWh > 0 ? spmSnittWh * 3600 / maaltW : 0;
  const dagS = maaltW > 0 ? aiWh * 3600 / maaltW : 0;
  const forhold = wh > 0 ? aiWh / wh : 0;
  const forholdTekst = forhold >= 1e6 ? `1 : ${komma(forhold / 1e6, 1)} millioner` : forhold > 0 ? `1 : ${sep(forhold)}` : "";
  const personer = maaltW > 0 ? Math.round(aiWh / (maaltW * 8)) : 0;

  const heroTall = (tekst, farge, str = 84) => `<div class="mono disp${nytt(tekst, tekst)}" style="font-size:${str}px;font-weight:500;line-height:0.95;color:${farge};letter-spacing:-0.02em">${tekst}</div>`;
  const pil = `<div style="font-size:44px;color:#3d3d3d;align-self:center;padding:0 6px">→</div>`;

  document.getElementById("rot").innerHTML = `
  <div class="kol" style="gap:9px;align-items:center;flex-shrink:0">
    <div class="lbl" style="color:#4ade80;font-size:15px">Sveiva mot AI-en</div>
    <div class="disp" style="font-size:46px;font-weight:700;line-height:1;text-align:center">Hvor lenge må du sveive for ett spørsmål?</div>
  </div>

  <!-- Svaret, lest som en setning fra venstre mot hoeyre -->
  <div style="display:flex;align-items:stretch;gap:18px;padding:30px 40px;background:#111;border:1px solid #282828;border-radius:16px;flex-shrink:0">
    <div class="kol" style="gap:10px;flex:1;min-width:0">
      ${ingenSveiv ? heroTall("—", "#767676") : heroTall(tidTekst(sveivS), "#4ade80")}
      <div style="font-size:18px;color:#ededed">${ingenSveiv ? "ingen har sveivet ennå i dag" : "har dere sveivet i dag"}</div>
      <div style="font-size:14px;color:#8a8a8a">${ingenSveiv ? "ta i, så begynner regnestykket" : `målt: ${whTekst(wh)} strøm, ${wattTekst(maaltW)} i snitt`}</div>
    </div>
    ${pil}
    <div class="kol" style="gap:10px;flex:1;min-width:0">
      ${spmS > 0 ? heroTall(tidTekst(spmS), "#f97316") : heroTall(spmSnittWh > 0 ? whTekst(spmSnittWh) : "—", "#f97316", 64)}
      <div style="font-size:18px;color:#ededed">for ett spørsmål</div>
      <div style="font-size:14px;color:#8a8a8a">${spmSnittWh > 0 ? `${whTekst(spmSnittWh)} i snitt i dag, lesing og svar` : "regnes når noen har spurt"}${spmS > 0 ? "" : " — i sveivetid når noen sveiver"}</div>
    </div>
    ${pil}
    <div class="kol" style="gap:10px;flex:1;min-width:0">
      ${dagS > 0 ? heroTall(tidTekst(dagS), "#c2410c") : heroTall(aiWh > 0 ? whTekst(aiWh) : "—", "#c2410c", 64)}
      <div style="font-size:18px;color:#ededed">for alt AI-en har brukt i dag</div>
      <div style="font-size:14px;color:#8a8a8a">${aiWh > 0 ? `${whTekst(aiWh)}, begge stasjonene` : "ingenting ennå"}${dagS > 0 ? "" : " — i sveivetid når noen sveiver"}</div>
    </div>
  </div>

  <!-- Maalestokken: lengder alle kjenner paa kroppen -->
  <div style="display:${wh > 0 && spmSnittWh > 0 ? "flex" : "none"};align-items:center;gap:22px;padding:18px 40px;background:#0e0e0e;border:1px solid #282828;border-left:5px solid #4ade80;border-radius:12px;flex-shrink:0">
    <div style="width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0;box-shadow:0 0 0 6px #14281a"></div>
    <div style="font-size:22px;color:#ededed;line-height:1.45">Hvis det dere har sveivet var <b>én millimeter</b>, ville ett spørsmål være <b style="color:#fb923c">${lengde(spmSnittWh / Math.max(wh, 1e-9))}</b>, og alt AI-en har brukt i dag <b style="color:#fb923c">${lengde(aiWh / Math.max(wh, 1e-9))}</b>.</div>
  </div>

  <div style="display:flex;gap:26px;flex-grow:1;min-height:0">
    <div class="kort kol" id="naa" style="flex:1;gap:0;padding:26px 30px;border-color:#1e3a24;min-height:0"></div>

    <div class="kort kol" style="width:640px;flex-shrink:0;gap:12px;padding:22px 30px;border-color:#3a2412;min-height:0">
      <div class="lbl" style="color:#f97316;font-size:15px">Energi i dag — hele rommet</div>
      <div style="display:flex;align-items:baseline;gap:12px">
        <div class="mono disp${nytt("aiWh", Math.round(aiWh * 100))}" style="font-size:48px;font-weight:500;line-height:0.92;color:#f97316">${komma(aiWh, 1)}</div>
        <div style="font-size:20px;color:#9a9a9a">Wh brukt</div>
      </div>
      <div class="kol" style="gap:9px">
        <div class="kol" style="gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:18px;color:#ededed">Halvor <span style="font-size:14px;color:#8a8a8a">— nettsidelesing</span></span>
            <span class="mono" style="font-size:18px;color:#818cf8">${komma(vaarWh, 1)} Wh</span>
          </div>
          <div style="height:22px;background:#1c1c1c;border-radius:6px;overflow:hidden"><div style="width:${(vaarWh / maksWh) * 100}%;height:100%;background:#4f46e5"></div></div>
        </div>
        <div class="kol" style="gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:18px;color:#ededed">Gjermund <span style="font-size:14px;color:#8a8a8a">— chatbot</span></span>
            <span class="mono" style="font-size:18px;color:#a78bfa">${komma(hansWh, 1)} Wh</span>
          </div>
          <div style="height:22px;background:#1c1c1c;border-radius:6px;overflow:hidden"><div style="width:${(hansWh / maksWh) * 100}%;height:100%;background:#a78bfa"></div></div>
        </div>
      </div>
      <div class="kol" style="gap:7px;padding-top:12px;border-top:1px solid #282828">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:18px;color:#ededed">Sveiva <span style="font-size:14px;color:#4ade80">— laget av rommet, målt</span></span>
          <span class="mono" style="font-size:18px;color:#4ade80">${ingenSveiv ? "ikke ennå" : whTekst(wh)}</span>
        </div>
        ${forhold > 0 ? `<div style="font-size:15px;color:#8a8a8a">Forholdet mellom laget og brukt: <span class="mono" style="color:#ededed">${forholdTekst}</span></div>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:4px">
          <span style="font-size:18px;color:#ededed">Kroppene deres <span style="font-size:14px;color:#fbbf24">— anslag</span></span>
          <span class="mono" style="font-size:18px;color:#fbbf24">${ingenSveiv ? "—" : komma(kroppKcal, kroppKcal < 10 ? 1 : 0) + " kcal"}</span>
        </div>
        <div style="font-size:14px;color:#8a8a8a">${ingenSveiv ? `${komma(KROPP_W, 0)} W ved lett armsveiving, regnet fra tid` : `≈ ${komma(kroppWh, 1)} Wh kroppsenergi for ${whTekst(wh)} strøm`}</div>
      </div>
      <div style="font-size:13px;color:#767676;line-height:1.45;margin-top:auto">Tokens er målt. Strømmen er regnet ut — ingen leverandør oppgir hvor mye ett spørsmål bruker. Halvor: EcoLogits for svaret pluss et FLOP-basert leseestimat${vaarLesing > 0 ? ` (lesingen er ${komma((vaarLesing / Math.max(vaarWh, 0.001)) * 100, 0)} % av hans andel)` : ""}. Gjermund: EcoLogits på gpt-5. ${komma(vannL * 1000, 0)} mL vann til kjøling, ${komma(aiWh / MOBIL_WH, 1)} mobilladinger.</div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:30px;padding:18px 32px;background:#0e0e0e;border:1px solid #282828;border-left:5px solid #fbbf24;border-radius:12px;flex-shrink:0">
    <div class="mono disp" style="font-size:34px;font-weight:500;line-height:1;color:${ingenSveiv ? "#767676" : "#fbbf24"};flex-shrink:0;white-space:nowrap">${ingenSveiv ? "—" : forholdTekst}</div>
    <div class="kol" style="gap:4px;flex-grow:1">
      <div style="font-size:19px;color:#ededed;line-height:1.4">${ingenSveiv
        ? "Sveiva har ikke vært i bruk ennå i dag. Tokentallene er ekte målinger; sveivetallene kommer så snart noen tar i."
        : `Så mye mer strøm har AI-en brukt enn rommet har laget. På slike sveiver måtte ${sep(personer)} personer sveivet åtte timer hver for å dekke dagen.`}</div>
      <div style="font-size:14px;color:#8a8a8a;line-height:1.45">Grønt er målt: volt ganger ampere ganger tid, fra sveiva. Oransje er regnet ut, ikke målt — ingen leverandør oppgir hvor mye strøm ett spørsmål bruker; vi regner både lesing og svar og oppgir alltid det laveste anslaget. Gult er et anslag for engasjement: ~${komma(KROPP_W, 0)} W ved lett armsveiving (3 MET), fra sveivetiden — det går aldri inn i det grønne.</div>
    </div>
  </div>`;
  tegnPuls();
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
