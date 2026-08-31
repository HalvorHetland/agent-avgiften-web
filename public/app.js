/* Telefonflyten — Agent-avgiften.
 *
 * Sju skjermer fra Mobil.dc.html, plus to feiltilstander som har egne artboards
 * (Frakoblet, Blokkert). Ingen rammeverk: én fil, ingen bygg, kan serveres fra
 * hva som helst statisk.
 *
 * Personvern: session_id er en uuid som lages her og aldri knyttes til noe om
 * personen. Den ligger i sessionStorage, ikke localStorage, slik at neste
 * student på samme telefon får en ny identitet.
 *
 * Kjør med ?stasjon=medstudent for den andre stasjonen.
 */

const FUNK = `${CFG.SUPABASE_URL}/functions/v1/ask`;
const REST = `${CFG.SUPABASE_URL}/rest/v1`;
const HODER = {
  "apikey": CFG.SUPABASE_ANON_KEY,
  "Authorization": `Bearer ${CFG.SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

const params = new URLSearchParams(location.search);
const STASJON = params.get("stasjon") === "medstudent" ? "medstudent" : "halvor";

/* Speiler sider.ts i Edge-funksjonen. Funksjonen avviser alt annet, så denne
 * lista kan aldri utvide hva som faktisk hentes — den bestemmer bare hva
 * brikkene viser. Forslagene er testet mot ekte sider: begge armene må kunne
 * svare, ellers demonstrerer standen at den billige armen er dårligere. */
const SIDER = [
  { navn: "posten.no", url: "https://www.posten.no/",
    forslag: ["hva kan jeg gjøre her?", "hvordan sender jeg en pakke?"] },
  { navn: "ruter.no", url: "https://ruter.no/",
    forslag: ["hvordan kjøper jeg billett?", "hva kan jeg gjøre her?"] },
  { navn: "oslo.kommune.no", url: "https://www.oslo.kommune.no/",
    forslag: ["hva kan jeg gjøre her?", "hvordan søker jeg barnehageplass?"] },
  { navn: "vy.no", url: "https://www.vy.no/",
    forslag: ["når går neste tog?"] },
];

const SP1 = "Har du tenkt på at AI-en må lese nettsider for å svare deg?";
const SP2 = "Hvem burde gjøre noe med dette?";

// ─────────────────────────────────────────────────────────────────── tilstand

let S = nyOkt();

function nyOkt() {
  const id = crypto.randomUUID();
  sessionStorage.setItem("okt", id);
  return {
    session_id: id,
    steg: 0,
    side: SIDER[0],
    oppgave: "",
    laster: false,
    resultat: null,   // { raa, rein }
    feil: null,       // { grunn, http_status, detalj }
    fritekst: "",
    totaler: null,
    ferdig: false,
  };
}

// ──────────────────────────────────────────────────────────── offline-kø
//
// Rader som ikke haster for studenten (holdninger, fritekst) legges i kø når
// nettet er borte og sendes når det er tilbake. Selve AI-kallet kan ikke køes
// — studenten trenger svaret nå — så det har sin egen Frakoblet-tilstand.

const KØ = "stand-ko";

const køLes = () => { try { return JSON.parse(localStorage.getItem(KØ) || "[]"); } catch { return []; } };
const køSkriv = (k) => { try { localStorage.setItem(KØ, JSON.stringify(k)); } catch { /* full disk, privat modus */ } };

function køLegg(tabell, rad) {
  const k = køLes();
  k.push({ tabell, rad, lagt: Date.now() });
  køSkriv(k);
  tegn();
}

/** Sender én rad. Returnerer true hvis den er endelig håndtert. */
async function send(tabell, rad) {
  const r = await fetch(`${REST}/${tabell}`, {
    method: "POST",
    // Ikke `resolution=ignore-duplicates`: den ber PostgREST lese for å løse
    // konflikten, og anon har med vilje ingen SELECT. Den unike indeksen på
    // (session_id, runde) gir 409 i stedet, som håndteres under.
    headers: { ...HODER, Prefer: "return=minimal" },
    body: JSON.stringify(rad),
  });
  // 409 betyr at raden alt finnes — køen har sendt den før. Det er en suksess.
  return r.ok || r.status === 409;
}

async function skriv(tabell, rad) {
  try {
    if (!navigator.onLine) { køLegg(tabell, rad); return; }
    if (!(await send(tabell, rad))) køLegg(tabell, rad);
  } catch { køLegg(tabell, rad); }
}

async function tømKø() {
  const k = køLes();
  if (!k.length) return;
  const igjen = [];
  for (const post of k) {
    try {
      if (!(await send(post.tabell, post.rad))) igjen.push(post);
    } catch { igjen.push(post); }
  }
  køSkriv(igjen);
  tegn();
}

addEventListener("online", tømKø);
tømKø();

// ─────────────────────────────────────────────────────── felles tall

/* booth_totals er den eneste visningen anon kan lese, og den inneholder bare
 * summer. Brukes til «rommet mot AI-en» på s5 og «du er nummer X» på s6.
 *
 * Feiler kallet, viser vi ingenting. Et oppdiktet tall er verre enn et
 * manglende — det gjelder her som på storskjermen. */
async function hentTotaler() {
  try {
    const r = await fetch(`${REST}/booth_totals?select=*`, { headers: HODER });
    if (!r.ok) return;
    const rad = (await r.json())[0];
    if (rad) { S.totaler = rad; tegn(); }
  } catch { /* frakoblet — boksen uteblir */ }
}

/* Frafall er data.
 *
 * En utstilling som mister folk på steg 3 er verdt å vite om når oppgaven skal
 * skrives — og det ser man ikke av målingene, bare av hvem som ikke kom fram.
 * Vi logger hvilket steg som ble nådd, aldri noe om personen. Feiler det, skal
 * det ikke merkes: en tapt hendelse er bedre enn en avbrutt flyt. */
const settSteg = new Set();
function loggSteg(navn) {
  if (settSteg.has(navn)) return;      // ett spor per steg per økt
  settSteg.add(navn);
  skriv("hendelser", {
    session_id: S.session_id, station: STASJON,
    slag: "steg", navn, detalj: { side: S.side?.navn ?? null },
  });
}

// ────────────────────────────────────────────────────────────── AI-kallet

async function spør() {
  S.laster = true; S.feil = null; S.resultat = null; tegn();

  const kropp = (variant) => ({
    session_id: S.session_id,
    station: STASJON,
    site_url: S.side.url,
    task_label: S.oppgave.trim(),
    oppgave_kilde: S.oppgaveKilde ?? "fritekst",
    variant,
  });

  try {
    // Begge armene samtidig. Funksjonen henter siden én gang per kall, men
    // begge kallene treffer samme side innenfor sekunder, så de måler samme
    // dokument. Serielt ville doblet ventetiden foran en kø av studenter.
    const [raa, rein] = await Promise.all([
      fetch(FUNK, { method: "POST", headers: HODER, body: JSON.stringify(kropp("raa")) }).then((r) => r.json()),
      fetch(FUNK, { method: "POST", headers: HODER, body: JSON.stringify(kropp("reint")) }).then((r) => r.json()),
    ]);

    if (!raa.ok || !rein.ok) {
      const d = !raa.ok ? raa : rein;
      S.feil = {
        grunn: d.grunn ?? "ukjent",
        http_status: d.http_status ?? null,
        detalj: d.detalj ?? "",
        brukt_usd: d.brukt_usd, budsjett_usd: d.budsjett_usd,
      };
    } else {
      S.resultat = { raa, rein };
      S.steg = 3;
    }
  } catch (err) {
    // Nettet forsvant midt i. Egen tilstand, ikke en generisk feil.
    S.feil = { grunn: navigator.onLine ? "nett" : "frakoblet", detalj: String(err?.message ?? err) };
  }
  S.laster = false;
  tegn();
}

// ────────────────────────────────────────────────────────────────── visning

// U+202F: smalt hardt mellomrom. Designet vil ha mellomrom som tusenskille,
// og et hardt et hindrer at «191 972» brekker midt i tallet.
const tall = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const app = () => document.getElementById("app");

function tegn() {
  if (S.session_id) loggSteg(`s${S.ferdig ? "ferdig" : S.steg}`);
  app().innerHTML = skjerm();
  app().querySelectorAll("[data-gaa]").forEach((el) => {
    el.onclick = () => {
      S.steg = Number(el.dataset.gaa);
      tegn();
      if (S.steg === 5 || S.steg === 6) hentTotaler();
    };
  });
  app().querySelectorAll("[data-handling]").forEach((el) => {
    el.onclick = () => HANDLINGER[el.dataset.handling](el);
  });
  const ta = app().querySelector("#oppgave");
  if (ta) {
    ta.oninput = () => {
      S.oppgave = ta.value.slice(0, 80);
      S.oppgaveKilde = "fritekst";
      const t = app().querySelector("#teller");
      if (t) t.textContent = `${[...S.oppgave].length}/80`;
      const k = app().querySelector("#spor");
      if (k) k.style.opacity = S.oppgave.trim() ? "1" : "0.4";
    };
  }
  const fr = app().querySelector("#fritekst");
  if (fr) fr.oninput = () => { S.fritekst = fr.value.slice(0, 500); };
}

const HANDLINGER = {
  svar1(el) {
    skriv("holdninger", { session_id: S.session_id, runde: "foer", question_key: "sp1_bevissthet", svar: el.dataset.verdi });
    S.steg = 1; tegn();
  },
  svar2(el) {
    skriv("holdninger", { session_id: S.session_id, runde: "etter", question_key: "sp2_ansvar", svar: el.dataset.verdi });
    S.steg = 5; tegn(); hentTotaler();
  },
  velgSide(el) { S.side = SIDER[Number(el.dataset.i)]; tegn(); },
  velgForslag(el) {
    // Kilden lagres: handoffen sier friteksten er data i seg selv, og da må vi
    // kunne skille de frie fra de valgte i analysen.
    S.oppgave = el.dataset.tekst;
    S.oppgaveKilde = "brikke";
    tegn();
  },
  spor() { if (S.oppgave.trim()) { S.steg = 2; tegn(); spør(); } },
  prøvIgjen() { spør(); },
  sendFritekst() {
    const t = S.fritekst.trim();
    if (t) skriv("free_text", { session_id: S.session_id, body: t.slice(0, 500) });
    S.fritekst = "";
    S.steg = 7; tegn(); hentTotaler();
  },
  hoppOver() { S.steg = 7; tegn(); hentTotaler(); },
  // Ny økt = ny anonym identitet. Resultatet fra forrige runde tas ikke med
  // videre; neste student skal ikke se noen andres tall.
  påNytt() { S = nyOkt(); tegn(); },
  // Rolig sluttilstand. Telefonen er studentens egen, så vi «logger ikke ut» —
  // vi slutter bare å be om noe.
  avslutt() { S.ferdig = true; tegn(); },
};

// ───────────────────────────────────────────────────────────────── skjermer

function skjerm() {
  if (S.laster) return laster();
  if (S.feil) return feilskjerm();
  return [s0, s1, null, s3, s4, s5, s6, s7][S.steg]?.() ?? s0();
}

const køLinje = () => {
  const n = køLes().length;
  return n ? `<div class="fin" style="color:#fbbf24">${n} svar venter på nett — de sendes automatisk</div>` : "";
};

function s0() {
  const alt = ["Ja, jeg tenker på det", "Har hørt om det", "Nei, aldri tenkt på det"];
  return `
  <div class="kol" style="gap:20px;height:100%">
    <div class="lbl" style="color:#f97316">Før vi begynner</div>
    <div class="disp" style="font-size:31px;font-weight:700;line-height:1.15">${SP1}</div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Ingen riktige svar. Vi spør igjen etterpå, og forskjellen er det vi er ute etter.</div>
    <div class="kol" style="gap:11px;margin-top:6px">
      ${alt.map((a) => `<div class="svar" data-handling="svar1" data-verdi="${esc(a)}">${a}</div>`).join("")}
    </div>
    <div style="margin-top:auto;display:flex;gap:11px;padding:15px 17px;background:#111;border:1px solid #282828;border-radius:11px">
      <div class="fin">Helt anonymt. Ingen innlogging, ingenting om deg lagres. Svarene brukes i masteroppgaven min.</div>
    </div>
    ${køLinje()}
  </div>`;
}

function s1() {
  return `
  <div class="kol" style="gap:19px;height:100%">
    <div class="kol" style="gap:8px">
      <div class="lbl" style="color:#f97316">Steg 1 av 3</div>
      <div class="disp" style="font-size:30px;font-weight:700;line-height:1.12">Velg en side, og si hva du vil gjøre der</div>
    </div>
    <div class="kol" style="gap:10px">
      <div class="lbl">Side</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${SIDER.map((s, i) => `<div class="chip${s.url === S.side.url ? " chip-on" : ""}" data-handling="velgSide" data-i="${i}">${s.navn}</div>`).join("")}
      </div>
    </div>
    <div class="kol" style="gap:9px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="lbl">Hva vil du gjøre der?</div>
        <div class="mono" id="teller" style="font-size:12px;color:#5a5a5a">${[...S.oppgave].length}/80</div>
      </div>
      <textarea id="oppgave" maxlength="80" placeholder="skriv med dine egne ord …"
        style="width:100%;height:84px;resize:none;padding:15px 16px;background:#111;border:1px solid #4f46e5;border-radius:11px;color:#ededed;font-family:inherit;font-size:16px;line-height:1.45;outline:none">${esc(S.oppgave)}</textarea>
    </div>
    <div class="kol" style="gap:10px">
      <div class="lbl">Eller velg et forslag</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${S.side.forslag.map((f) => `<div class="chip${f === S.oppgave ? " chip-on" : ""}" data-handling="velgForslag" data-tekst="${esc(f)}">${f}</div>`).join("")}
      </div>
    </div>
    <div class="btn" id="spor" data-handling="spor" style="margin-top:auto;opacity:${S.oppgave.trim() ? 1 : 0.4}">
      <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Spør AI-en</span>
    </div>
  </div>`;
}

/* s2 i designet er forklaringsskjermen mens kallet går. Den er derfor
 * lastetilstanden her: samme innhold, med en ekte framdriftslinje i stedet for
 * en statisk. */
function laster() {
  return `
  <div class="kol" style="gap:17px;height:100%">
    <div class="kol" style="gap:7px;align-items:center">
      <div class="lbl" style="color:#f97316">Spør nå</div>
      <div class="mono" style="font-size:18px;color:#ededed">${S.side.navn}</div>
      <div style="font-size:15px;color:#9a9a9a;text-align:center">«${esc(S.oppgave)}»</div>
    </div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.45;text-align:center">Samme spørsmål, to ulike versjoner av siden:</div>
    <div class="kol" style="gap:12px">
      <div class="kol" style="gap:9px;padding:15px 16px;background:#111;border:1px solid #3a2412;border-radius:11px">
        <div style="display:flex;align-items:center;gap:11px">
          <div style="width:10px;height:10px;border-radius:999px;background:#f97316;flex-shrink:0"></div>
          <div style="font-size:16px;color:#ededed;font-weight:600">Hele siden slik den er kodet</div>
        </div>
        <div class="mono" style="font-size:10px;color:#5a5a5a;line-height:1.5;background:#0a0a0a;border-radius:6px;padding:9px 10px;max-height:50px;overflow:hidden">&lt;div class="c-header__inner" data-module="nav"<br>aria-hidden="false"&gt;&lt;script&gt;window.__cmp=<br>{"consent":false,"vendors":[41,52,…</div>
        <div style="font-size:13.5px;color:#9a9a9a;line-height:1.4">kode, menyer, cookie-banner, reklame — alt</div>
      </div>
      <div class="kol" style="gap:9px;padding:15px 16px;background:#111;border:1px solid #1e3a24;border-radius:11px">
        <div style="display:flex;align-items:center;gap:11px">
          <div style="width:10px;height:10px;border-radius:999px;background:#4ade80;flex-shrink:0"></div>
          <div style="font-size:16px;color:#ededed;font-weight:600">Bare teksten på siden</div>
        </div>
        <div class="mono" style="font-size:11px;color:#9a9a9a;line-height:1.5;background:#0a0a0a;border-radius:6px;padding:9px 10px;max-height:50px;overflow:hidden">${esc(S.side.navn)}<br>hovedinnholdet, uten kode</div>
        <div style="font-size:13.5px;color:#9a9a9a;line-height:1.4">det du faktisk leser</div>
      </div>
    </div>
    <div style="height:5px;background:#1c1c1c;border-radius:999px;overflow:hidden">
      <div class="skyv" style="height:100%;background:#f97316;border-radius:999px"></div>
    </div>
    <div style="text-align:center;font-size:14px;color:#6b6b6b">Begge spørsmålene går nå. Den store siden tar lengst tid.</div>
  </div>`;
}

function s3() {
  const { raa, rein } = S.resultat;
  const forhold = raa.input_tokens / rein.input_tokens;
  const bredde = Math.max(0.6, (rein.input_tokens / raa.input_tokens) * 100);
  const meter = Math.round(forhold);
  return `
  <div class="kol" style="gap:16px;height:100%;overflow-y:auto">
    <div class="kol" style="gap:7px">
      <div class="lbl" style="color:#f97316">Steg 2 av 3</div>
      <div class="disp" style="font-size:27px;font-weight:700;line-height:1.15">Begge svarene ble riktige</div>
      <div style="font-size:14.5px;color:#9a9a9a;line-height:1.45">«${esc(rein.answer.split("\n")[0].slice(0, 120))}»</div>
    </div>
    <div class="kol" style="gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#ededed">Hele siden slik den er kodet</span>
        <span class="mono disp" style="font-size:22px;font-weight:500;color:#f97316">${tall(raa.input_tokens)}</span>
      </div>
      <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:100%;height:100%;background:#f97316"></div></div>
    </div>
    <div class="kol" style="gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#ededed">Bare teksten på siden</span>
        <span class="mono disp" style="font-size:22px;font-weight:500;color:#4ade80">${tall(rein.input_tokens)}</span>
      </div>
      <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:${bredde}%;min-width:7px;height:100%;background:#4ade80"></div></div>
    </div>
    <div style="display:flex;align-items:center;gap:14px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
      <div class="mono disp" style="font-size:38px;font-weight:500;line-height:1;color:#fb923c;flex-shrink:0">${forhold < 10 ? forhold.toFixed(1) : Math.round(forhold)}×</div>
      <div style="font-size:14.5px;color:#cfcfcf;line-height:1.45">så mye tekst måtte AI-en lese for nøyaktig samme svar<br><span style="color:#6b6b6b">tokens = tekstbitene den betaler for</span></div>
    </div>
    <div class="kol" style="gap:7px;padding:16px 17px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:15px;color:#ededed;line-height:1.5">Som å kjøre <b>${tall(meter)} meter</b> i elbil for å hente noe som ligger <b>én meter</b> unna.</div>
      <div class="fin">Et bilde på forholdet, ikke et energitall.</div>
    </div>
    ${raa.truncated ? `<div class="kol" style="gap:6px;padding:14px 16px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:14px;color:#ededed;line-height:1.45">Siden var for stor til å sendes hel. Vi sendte de første <span class="mono">${tall(raa.input_tokens)}</span> tokenene.</div>
      <div class="fin">Det ekte tallet er altså høyere enn det som står over.</div></div>` : ""}
    <div class="btn" data-gaa="4" style="margin-top:auto;flex-shrink:0">
      <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Videre</span>
    </div>
  </div>`;
}

function s4() {
  const alt = ["Nettstedene — de burde være lettere å lese", "AI-selskapene — de burde lese smartere", "Begge to", "Det er greit som det er"];
  return `
  <div class="kol" style="gap:20px;height:100%">
    <div class="lbl" style="color:#f97316">Ett spørsmål til</div>
    <div class="disp" style="font-size:31px;font-weight:700;line-height:1.15">${SP2}</div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Det finnes ikke noe fasitsvar. Vi vil vite hva du mener nå som du har sett tallet.</div>
    <div class="kol" style="gap:11px;margin-top:4px">
      ${alt.map((a) => `<div class="svar" data-handling="svar2" data-verdi="${esc(a)}">${a}</div>`).join("")}
    </div>
  </div>`;
}

function s5() {
  return `
  <div class="kol" style="gap:18px;height:100%">
    <div class="kol" style="gap:8px">
      <div class="lbl" style="color:#4ade80">Steg 3 av 3</div>
      <div class="disp" style="font-size:30px;font-weight:700;line-height:1.12">Nå lager du strømmen selv</div>
    </div>
    <div class="kol" style="gap:6px;align-items:center;padding:22px;background:#111;border:1px solid #1e3a24;border-radius:14px">
      <div class="mono disp" style="font-size:68px;font-weight:500;line-height:1;color:#4ade80">864</div>
      <div style="font-size:16px;color:#9a9a9a">joule for ett spørsmål</div>
      <div style="font-size:15px;color:#6b6b6b;margin-top:4px">omtrent 21 sekunder på sveiva</div>
    </div>
    <div class="kol" style="gap:9px;padding:16px 17px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:15px;color:#ededed;line-height:1.5">De 21 sekundene gir like mye strøm som <b>9 sekunder</b> med TV-en på. Eller <b>2 %</b> av mobilbatteriet ditt.</div>
      <div class="fin">TV på 100 W, mobilbatteri på 12 Wh, 0,24 Wh per forespørsel (Google, 2025 — median tekstforespørsel). Poenget er ikke at ett spørsmål er mye — det er hvor lite en kropp orker å lage.</div>
    </div>
    ${rommetBoks()}
    <div class="btn" data-gaa="6" style="margin-top:auto">
      <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Jeg har sveivet</span>
    </div>
  </div>`;
}

function s6() {
  return `
  <div class="kol" style="gap:18px;height:100%">
    <div class="lbl" style="color:#4ade80">Takk</div>
    <div class="disp" style="font-size:31px;font-weight:700;line-height:1.15">Hva overrasket deg?</div>
    <textarea id="fritekst" maxlength="500" placeholder="Skriv én setning … (frivillig)"
      style="width:100%;height:120px;resize:none;padding:15px 16px;background:#111;border:1px solid #4f46e5;border-radius:11px;color:#ededed;font-family:inherit;font-size:16px;line-height:1.5;outline:none">${esc(S.fritekst)}</textarea>
    <div class="fin">Svaret er anonymt og kan bli sitert i oppgaven. Ikke skriv noe som kan identifisere deg.</div>
    ${nummerBoks()}
    ${køLinje()}
    <div class="kol" style="gap:11px;margin-top:auto">
      <div class="btn" data-handling="sendFritekst"><span class="disp" style="font-size:19px;font-weight:700;color:#fff">Send inn</span></div>
      <div class="btn-ghost" data-handling="hoppOver"><span style="font-size:17px;color:#9a9a9a">Hopp over</span></div>
    </div>
  </div>`;
}

/* «Rommet mot AI-en»: hvor stor andel av dagens AI-energi rommet har sveivet
 * inn. AI-siden regnes om med den etterprøvde konstanten — 0,24 Wh = 864 J per
 * forespørsel (arXiv:2508.15734). Se docs/omregningskonstanten.md. */
function rommetBoks() {
  const t = S.totaler;
  if (!t) return "";
  const aiJoule = Number(t.kall) * 864;
  const sveivJoule = Number(t.joules);
  if (aiJoule <= 0) {
    return `<div class="kol" style="gap:10px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
      <div class="disp" style="font-size:18px;font-weight:700">Rommet mot AI-en</div>
      <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">Du er den første i dag. Alt du sveiver går i samme pott.</div>
    </div>`;
  }
  const dekning = (sveivJoule / aiJoule) * 100;
  return `<div class="kol" style="gap:10px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
    <div class="disp" style="font-size:18px;font-weight:700">Rommet mot AI-en</div>
    <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">Alt dere sveiver går i samme pott. Akkurat nå dekker den <span class="mono" style="color:#fbbf24">${dekning < 1 && dekning > 0 ? dekning.toFixed(1) : Math.round(dekning)} %</span> av det standen har brukt i dag.</div>
  </div>`;
}

/* «Du er nummer X i dag». spoersmaal teller unike session_id i ai_runs. */
function nummerBoks() {
  const t = S.totaler;
  if (!t) return "";
  return `<div class="kol" style="gap:10px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
    <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">Du er nummer <span class="mono" style="color:#4ade80">${tall(t.spoersmaal)}</span> i dag. Til sammen har dere sveivet inn <span class="mono" style="color:#4ade80">${tall(t.joules)} J</span>.</div>
  </div>`;
}

/* Steg 7 — avslutning.
 *
 * Studenten skal kunne gå ryddig ut, eller ta en runde til med en annen side.
 * Vi viser deres eget måletall en siste gang, fordi det er det de husker når
 * de går fra standen. */
function s7() {
  if (S.ferdig) return ferdig();

  const r = S.resultat;
  const forhold = r ? r.raa.input_tokens / r.rein.input_tokens : null;

  return `
  <div class="kol" style="gap:19px;height:100%">
    <div class="lbl" style="color:#4ade80">Ferdig</div>
    <div class="disp" style="font-size:33px;font-weight:700;line-height:1.13">Takk — svaret ditt er med i oppgaven</div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Helt anonymt. Ingenting om deg er lagret, bare tallene og det du svarte.</div>

    ${r ? `<div class="kol" style="gap:12px;padding:18px 19px;background:#111;border:1px solid #282828;border-radius:12px">
      <div class="lbl">Din måling</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#9a9a9a">Hele siden slik den er kodet</span>
        <span class="mono" style="font-size:18px;color:#f97316">${tall(r.raa.input_tokens)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#9a9a9a">Bare teksten på siden</span>
        <span class="mono" style="font-size:18px;color:#4ade80">${tall(r.rein.input_tokens)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding-top:11px;border-top:1px solid #282828">
        <span style="font-size:14.5px;color:#ededed">Forskjell</span>
        <span class="mono disp" style="font-size:24px;color:#fb923c">${forhold < 10 ? forhold.toFixed(1) : Math.round(forhold)}×</span>
      </div>
    </div>` : ""}

    ${nummerBoks()}
    ${køLinje()}

    <div class="kol" style="gap:11px;margin-top:auto">
      <div class="btn" data-handling="påNytt"><span class="disp" style="font-size:19px;font-weight:700;color:#fff">Prøv en annen side</span></div>
      <div class="btn-ghost" data-handling="avslutt"><span style="font-size:17px;color:#9a9a9a">Jeg er ferdig</span></div>
    </div>
  </div>`;
}

/* Sluttbildet. Med vilje stille: ingen knapper som lokker videre, bare en
 * vei tilbake hvis noen ombestemmer seg og gir telefonen til en venn. */
function ferdig() {
  return `
  <div class="kol" style="gap:22px;height:100%;justify-content:center;align-items:center;text-align:center">
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6 9 17l-5-5"/>
    </svg>
    <div class="disp" style="font-size:30px;font-weight:700;line-height:1.15">Takk for at du bidro</div>
    <div style="font-size:15.5px;color:#9a9a9a;line-height:1.55;max-width:280px">Målingene dine er en del av datagrunnlaget i masteroppgaven om hva det koster en AI å lese nettsider.</div>
    <div style="font-size:14px;color:#5a5a5a;line-height:1.5;max-width:280px">Ta gjerne en titt på storskjermen — tallene dine er allerede med der.</div>
    <div class="btn-ghost" data-handling="påNytt" style="margin-top:14px;padding:0 26px"><span style="font-size:16px;color:#6b6b6b">Start på nytt</span></div>
  </div>`;
}

// ────────────────────────────────────────────────────────── feiltilstander

function feilskjerm() {
  if (S.feil.grunn === "blokkert") return blokkert();
  if (S.feil.grunn === "frakoblet") return frakoblet();
  if (S.feil.grunn === "budsjett") return budsjettSlutt();
  return genereltAvbrudd();
}

/* Budsjettet for standen er brukt opp. Studenten skal ikke få en API-feil i
 * fjeset, og skal ikke få et oppdiktet tall heller. Vi sier som det er — og
 * det er faktisk en del av poenget: målingen koster penger fordi tokens
 * koster penger. */
function budsjettSlutt() {
  const b = S.feil;
  return `
  <div class="kol" style="gap:17px;height:100%">
    <div class="lbl" style="color:#fbbf24">Dagens m\u00e5linger er brukt opp</div>
    <div class="disp" style="font-size:29px;font-weight:700;line-height:1.15">Vi har brukt opp budsjettet for i dag</div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Hvert sp\u00f8rsm\u00e5l standen stiller koster ekte penger, fordi tokens koster ekte penger. Det er ikke en feil \u2014 det er den samme regningen utstillingen handler om.</div>
    <div class="kol" style="gap:8px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#ededed">Brukt i dag</span>
        <span class="mono disp" style="font-size:22px;color:#fbbf24">${(b.brukt_usd ?? 0).toFixed(2)} $</span>
      </div>
      <div style="height:10px;background:#1c1c1c;border-radius:999px;overflow:hidden">
        <div style="width:100%;height:100%;background:#fbbf24"></div>
      </div>
      <div class="fin">av et budsjett p\u00e5 ${(b.budsjett_usd ?? 0).toFixed(2)} $</div>
    </div>
    <div class="kol" style="gap:11px;margin-top:auto">
      <div class="btn" data-gaa="4"><span class="disp" style="font-size:19px;font-weight:700;color:#fff">G\u00e5 videre til sveiva</span></div>
    </div>
  </div>`;
}

/* Artboard `Blokkert`. En side som svarer 403 er et funn, ikke en feil — og
 * kopien i designet sier nettopp det. */
function blokkert() {
  return `
  <div class="kol" style="gap:17px;height:100%">
    <div class="lbl" style="color:#fbbf24">Sjelden fangst</div>
    <div class="disp" style="font-size:29px;font-weight:700;line-height:1.15">Denne siden nektet agenten innsyn</div>
    <div class="mono" style="font-size:16px;color:#fbbf24">${esc(S.side.navn)} · HTTP ${S.feil.http_status ?? "403"}</div>
    <div class="kol" style="gap:9px;padding:16px 17px;background:#111;border:1px solid #282828;border-radius:11px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:15px;color:#ededed">Anonym agent</span>
        <span class="mono" style="font-size:16px;color:#fbbf24">Avvist</span>
      </div>
      <div style="font-size:14px;color:#9a9a9a;line-height:1.45">Serveren svarte ${S.feil.http_status ?? 403} før noe innhold ble sendt. Agenten fikk aldri se siden.</div>
    </div>
    <div class="kol" style="gap:7px;padding:16px 17px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:15.5px;color:#ededed;font-weight:600;line-height:1.4">Dette er ikke en feil i målingen</div>
      <div style="font-size:14px;color:#cfcfcf;line-height:1.5">En side som stenger ute alt som ikke ser ut som en nettleser, stenger også ute assistenten du ber om hjelp. «Tilgjengelig for mennesker» og «tilgjengelig for maskiner» er to forskjellige spørsmål — og bare det ene blir målt i dag.</div>
    </div>
    <div class="btn" data-gaa="1" style="margin-top:auto">
      <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Prøv en annen side</span>
    </div>
  </div>`;
}

/* Artboard `Frakoblet`. Studenten skal kunne gå videre; svarene ligger trygt. */
function frakoblet() {
  const n = køLes().length;
  return `
  <div class="kol" style="gap:17px;height:100%">
    <div class="lbl" style="color:#fbbf24">Ingen nettforbindelse</div>
    <div class="disp" style="font-size:29px;font-weight:700;line-height:1.15">Vi når ikke AI-en akkurat nå</div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Svarene dine ligger trygt på telefonen. De sendes automatisk så snart nettet er tilbake — du kan gå videre som normalt.</div>
    ${n ? `<div class="kol" style="gap:6px;padding:15px 17px;background:#111;border:1px solid #282828;border-radius:11px">
      <div class="mono" style="font-size:17px;color:#fbbf24">${n} svar venter</div>
      <div class="fin">Sendes av seg selv når nettet kommer tilbake.</div></div>` : ""}
    <div class="kol" style="gap:11px;margin-top:auto">
      <div class="btn" data-handling="prøvIgjen"><span class="disp" style="font-size:19px;font-weight:700;color:#fff">Prøv igjen</span></div>
      <div class="btn-ghost" data-gaa="4"><span style="font-size:17px;color:#9a9a9a">Gå videre uten tallet</span></div>
    </div>
  </div>`;
}

/* Modellen eller nettet feilet. Vi viser feilen ærlig — aldri et
 * forhåndsregnet tall presentert som målt. */
function genereltAvbrudd() {
  return `
  <div class="kol" style="gap:17px;height:100%">
    <div class="lbl" style="color:#fbbf24">Det stoppet opp</div>
    <div class="disp" style="font-size:29px;font-weight:700;line-height:1.15">Vi fikk ikke målt denne gangen</div>
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Vi viser ikke et tall vi ikke har målt, så her står det heller ingenting. Prøv igjen, eller velg en annen side.</div>
    <div class="mono" style="font-size:12px;color:#5a5a5a;background:#0e0e0e;border:1px solid #282828;border-radius:9px;padding:12px 13px;line-height:1.5;word-break:break-word">${esc(S.feil.grunn)}${S.feil.http_status ? " · HTTP " + S.feil.http_status : ""}<br>${esc(String(S.feil.detalj).slice(0, 180))}</div>
    <div class="kol" style="gap:11px;margin-top:auto">
      <div class="btn" data-handling="prøvIgjen"><span class="disp" style="font-size:19px;font-weight:700;color:#fff">Prøv igjen</span></div>
      <div class="btn-ghost" data-gaa="1"><span style="font-size:17px;color:#9a9a9a">Velg en annen side</span></div>
    </div>
  </div>`;
}

tegn();
