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
 * lista kan aldri utvide hva som faktisk hentes eller spørres om.
 *
 * Aktiviteter i stedet for fritekst. Det koster ett datapunkt — hva studenter
 * *ville* gjort på disse sidene — men gir tre ting igjen:
 *
 *   1. Sammenlignbarhet på tvers. Med fritekst er de to armene sammenlignbare
 *      innad i én økt, men ikke mellom studenter. Nå kan du aggregere per
 *      (side, aktivitet) og se spredningen i tokentall for samme spørsmål.
 *   2. Ingen prompt-injeksjonsflate. Ingen tekst fra en besøkende når modellen.
 *   3. Oppgaven kan vises på storskjermen. Handoffen forbød det fordi teksten
 *      var fri; en fast liste er trygg å projisere.
 *
 * `nokkel` er det analysen grupperer på — teksten kan omformuleres uten at
 * dataene brytes. Alle er testet mot ekte sider: begge armene må kunne svare,
 * ellers demonstrerer standen at den billige armen er dårligere. */
const SIDER = [
  { navn: "posten.no", url: "https://www.posten.no/", aktiviteter: [
    { nokkel: "posten_oversikt", tekst: "hva kan jeg gjøre her?" },
    { nokkel: "posten_sende",    tekst: "hvordan sender jeg en pakke?" },
    { nokkel: "posten_spore",    tekst: "hvordan sporer jeg en pakke?" },
    { nokkel: "posten_flytte",   tekst: "hvordan melder jeg flytting?" },
  ] },
  { navn: "ruter.no", url: "https://ruter.no/", aktiviteter: [
    { nokkel: "ruter_oversikt", tekst: "hva kan jeg gjøre her?" },
    { nokkel: "ruter_billett",  tekst: "hvordan kjøper jeg billett?" },
    { nokkel: "ruter_priser",   tekst: "hva koster det å reise?" },
    { nokkel: "ruter_student",  tekst: "finnes det studentrabatt?" },
  ] },
  { navn: "oslo.kommune.no", url: "https://www.oslo.kommune.no/", aktiviteter: [
    { nokkel: "oslo_oversikt",  tekst: "hva kan jeg gjøre her?" },
    { nokkel: "oslo_barnehage", tekst: "hvordan søker jeg barnehageplass?" },
    { nokkel: "oslo_kontakt",   tekst: "hvordan kontakter jeg kommunen?" },
    { nokkel: "oslo_avfall",    tekst: "hvordan leverer jeg avfall?" },
  ] },
  /* avviser: verifisert 31. aug 2026 at siden svarer 403 på hver automatiske
   * forespørsel, også en helt vanlig curl uten noe med standen å gjøre.
   * Flagget styrer ordlyden på blokkert-skjermen: uten det kan vi bare påstå
   * at DETTE forsøket ble avvist, ikke at siden alltid gjør det. */
  { navn: "vy.no", url: "https://www.vy.no/", avviser: true, aktiviteter: [
    { nokkel: "vy_oversikt", tekst: "hva kan jeg gjøre her?" },
    { nokkel: "vy_tog",      tekst: "når går neste tog?" },
  ] },
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
    aktivitet: null,
    sideValgt: false,
    fase: null,
    malt: null,
    laster: false,
    resultat: null,   // { raa, rein }
    visSvar: false,
    klar: false,      // maalingen ferdig, venter paa at brukeren trykker Neste
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

/* Kjører målingen, og lar den besøkende se den skje.
 *
 * Tørrkjøringen først. Den henter siden og trekker ut hovedinnholdet uten å
 * kalle modellen, og returnerer ekte tegnantall på rundt halvannet sekund. Det
 * gir oss tall å vise MENS agenten jobber, i stedet for en spinner.
 *
 * Alt som vises er målt. Ingen falsk framdrift, ingen påfunnet prosent — hvert
 * steg fylles inn når det faktisk er ferdig. Det er den samme regelen som
 * gjelder på storskjermen, og den gjelder her fordi en besøkende som tar oss i
 * å pynte på ventetiden har god grunn til å tvile på resten av tallene også.
 *
 * Bonus: en blokkert side oppdages nå før noe modellkall i det hele tatt
 * forsøkes. */
async function spør() {
  S.laster = true; S.feil = null; S.resultat = null;
  S.fase = "henter"; S.malt = null;
  tegn();

  const kropp = (ekstra) => ({
    session_id: S.session_id,
    station: STASJON,
    site_url: S.side.url,
    task_label: S.oppgave.trim(),
    oppgave_nokkel: S.aktivitet,
    ...ekstra,
  });

  const kall = (kr) =>
    fetch(FUNK, { method: "POST", headers: HODER, body: JSON.stringify(kr) }).then((r) => r.json());

  try {
    // ── 1. agenten åpner og leser sida ────────────────────────────────────
    const t0 = Date.now();
    const tørr = await kall(kropp({ variant: "raa", toerrkjoer: true }));
    const hentet_ms = Date.now() - t0;

    if (!tørr.ok) {
      // Blokkert eller utilgjengelig. Ingen tokens brukt, ingen rad skrevet.
      S.feil = { grunn: tørr.grunn ?? "ukjent", http_status: tørr.http_status ?? null, detalj: tørr.detalj ?? "" };
      S.laster = false; S.fase = null; tegn();
      return;
    }

    S.malt = {
      raa_tegn: tørr.raa_tegn,
      reint_tegn: tørr.reint_tegn,
      utdrag: (tørr.reint_utdrag || "").replace(/\s+/g, " ").trim().slice(0, 120),
      hentet_ms,
    };
    // Ett kort opphold så tallene rekker å bli lest før neste steg starter.
    // Det er presentasjon av en måling som allerede er gjort, ikke falsk tid.
    /* Hvert steg må rekke å bli lest. En bruker meldte at skjermen gikk for
     * fort — og det er nettopp her hun ser at agenten leser hele siden for å
     * finne litt tekst. Pausene presenterer en måling som alt er gjort; de
     * later ikke som noe arbeid pågår. */
    S.fase = "lest"; tegn();
    await new Promise((r) => setTimeout(r, 2200));

    // ── 2. begge armene til modellen ──────────────────────────────────────
    S.fase = "sender"; tegn();
    const [raa, rein] = await Promise.all([
      kall(kropp({ variant: "raa" })),
      kall(kropp({ variant: "reint" })),
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
      /* Ikke hopp videre av seg selv. Den besøkende bestemmer når hun har
       * sett nok — ellers forsvinner tallene før de er lest. */
      S.fase = "klar"; S.klar = true;
      tegn();
      return;
    }
  } catch (err) {
    S.feil = { grunn: navigator.onLine ? "nett" : "frakoblet", detalj: String(err?.message ?? err) };
  }
  S.laster = false; S.fase = null;
  tegn();
}

// ────────────────────────────────────────────────────────────────── visning

// U+202F: smalt hardt mellomrom. Designet vil ha mellomrom som tusenskille,
// og et hardt et hindrer at «191 972» brekker midt i tallet.
const tall = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
/* Desimaltall med norsk komma. Fantes bare på de to storskjermene; telefonen
 * trengte den da energien gikk fra joule (heltall) til wattimer. */
const komma = (n, d = 2) => Number(n).toLocaleString("nb-NO", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const app = () => document.getElementById("app");

function tegn() {
  if (S.session_id) loggSteg(`s${S.ferdig ? "ferdig" : S.steg}`);
  app().innerHTML = skjerm();
  /* Hver tegning bygger DOM-en på nytt, og scrollposisjonen nullstilles.
   * I samtalen betyr det at hvert trykk kastet den besøkende til toppen —
   * eget svar og neste spørsmål havnet under folden. Chat ruller til nyeste. */
  const samtale = document.getElementById("samtale");
  if (samtale) samtale.scrollTop = samtale.scrollHeight;
  app().querySelectorAll("[data-gaa]").forEach((el) => {
    el.onclick = () => {
      /* Å navigere til et steg betyr å forlate feiltilstanden. Uten dette
       * vinner `if (S.feil)` i skjerm() over steget, feilskjermen tegnes på
       * nytt, og knappen ser død ut — det var den for alle fire
       * feilskjermene, og eneste vei ut var å laste siden på nytt. */
      S.feil = null;
      S.steg = Number(el.dataset.gaa);
      tegn();
      if (S.steg === 5 || S.steg === 6) hentTotaler();
    };
  });
  app().querySelectorAll("[data-handling]").forEach((el) => {
    el.onclick = () => HANDLINGER[el.dataset.handling](el);
  });
  // Oppgave-tekstboksen er borte; aktiviteten velges nå fra en liste.
  // Sluttskjermens fritekst står igjen — den er frivillig og går ikke til
  // modellen, bare til free_text.
  const fr = app().querySelector("#fritekst");
  if (fr) fr.oninput = () => { S.fritekst = fr.value.slice(0, 500); };

  /* En feilskjerm uten en fungerende vei ut er en blindvei: besøkende må
   * laste siden på nytt, og standen mister dem. Sjekk at det finnes minst én
   * klikkbar utgang hver gang en feilskjerm tegnes. */
  if (S.feil && !app().querySelector("[data-gaa],[data-handling]")) {
    console.error("Feilskjerm uten vei ut:", S.feil.grunn);
  }
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
  velgSide(el) {
    // Aktiviteten hører til siden. Bytter du side, må valget nullstilles,
    // ellers sendes forrige sides spørsmål til en ny side.
    S.aktivitet = null; S.oppgave = ""; S.sideValgt = true;
    S.side = SIDER[Number(el.dataset.i)]; tegn(); },
  velgAktivitet(el) {
    const a = S.side.aktiviteter.find((x) => x.nokkel === el.dataset.nokkel);
    if (!a) return;
    S.aktivitet = a.nokkel;
    S.oppgave = a.tekst;
    tegn();
  },
  ingenting() {},
  tilResultat() { S.laster = false; S.fase = null; S.klar = false; S.steg = 3; tegn(); },
  visSvar() { S.visSvar = !S.visSvar; tegn(); },
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
      <div class="fin">Helt anonymt. Ingen innlogging, og ingenting som kan identifisere deg lagres. Svarene brukes i masteroppgaven min.</div>
    </div>
    ${køLinje()}
  </div>`;
}

/* Steg 1 som en samtale med en assistent.
 *
 * Hensikten er gjenkjennelse: studenten skal kjenne igjen situasjonen «jeg ber
 * en AI om å gjøre noe for meg», fordi det er den situasjonen målingen handler
 * om. Formen er en chat; utseendet er standens eget, ikke et bestemt produkts.
 *
 * Meldingene avdekkes etter hvert som valgene tas, så det leses som en
 * samtale i stedet for et skjema. */
function s1() {
  // Sida vises først når den er aktivt valgt. Standardsida i nyOkt() skal
  // ikke gi assistenten svar den ikke har fått.
  const side = S.sideValgt ? S.side : null;
  const valgt = S.aktivitet;
  const akt = valgt ? S.side.aktiviteter.find((a) => a.nokkel === valgt) : null;

  return `
  <div class="kol" style="gap:14px;height:100%">
    <div class="kol" style="gap:8px">
      <div class="lbl" style="color:#f97316">Steg 1 av 3</div>
      <div class="disp" style="font-size:27px;font-weight:700;line-height:1.15">Be assistenten om noe</div>
    </div>

    <div class="kol" id="samtale" style="gap:13px;overflow-y:auto;flex:1;min-height:0;padding-bottom:4px">

      <div class="rad${side ? "" : " inn"}">
        ${avatar()}
        <div class="boble boble-ai">Hei. Jeg er en AI-assistent.<br>Hvilken nettside skal jeg gjøre noe på?</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:40px">
        ${SIDER.map((x, i) => `<div class="chip${side && x.url === S.side.url ? " chip-on" : ""}" data-handling="velgSide" data-i="${i}">${x.navn}</div>`).join("")}
      </div>

      ${side ? `
      <div class="rad rad-du${akt ? "" : " inn"}">
        <div class="boble boble-du">${esc(S.side.navn)}</div>
      </div>

      <div class="rad${akt ? "" : " inn"}">
        ${avatar()}
        <div class="boble boble-ai">Greit. Hva vil du at jeg skal gjøre på ${esc(S.side.navn)}?</div>
      </div>

      <div class="kol" style="gap:9px;padding-left:40px">
        ${S.side.aktiviteter.map((a) => `
          <div class="svar${valgt === a.nokkel ? " svar-on" : ""}" data-handling="velgAktivitet" data-nokkel="${a.nokkel}" style="font-size:16px">
            ${a.tekst}
          </div>`).join("")}
      </div>` : ""}

      ${akt ? `
      <div class="rad rad-du inn">
        <div class="boble boble-du">${esc(akt.tekst)}</div>
      </div>` : ""}
    </div>

    <div class="kol" style="gap:10px">
      <div class="btn${akt ? "" : " btn-av"}" data-handling="${akt ? "spor" : "ingenting"}">
        <span class="disp" style="font-size:18px;font-weight:700;color:${akt ? "#fff" : "#5a5a5a"}">Send til assistenten</span>
      </div>
      <div class="fin">Assistenten svarer to ganger: én gang etter å ha lest hele siden med menyer, reklame og alt det usynlige, én gang etter bare teksten. Du får se forskjellen.</div>
    </div>
    ${køLinje()}
  </div>`;
}

/** Assistentens ikon. Strektegnet SVG, ingen emoji, som resten av designet. */
function avatar() {
  return `<div class="avatar">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/>
      <path d="M9 13v1M15 13v1"/>
    </svg>
  </div>`;
}

/* Lastesiden viser agentens arbeid som en sjekkliste som fylles inn.
 *
 * Tre steg, i den rekkefølgen funksjonen faktisk gjør dem. Tallene til høyre
 * er målte, ikke anslag. Utdraget nederst er de første ordene Readability
 * faktisk fant, så den besøkende ser forskjellen mellom «hele siden» og «bare
 * teksten» med egne øyne før modellen har svart. */
function laster() {
  const f = S.fase, m = S.malt;
  const ferdig = { henter: 0, lest: 1, sender: 2, klar: 3 }[f] ?? 0;

  const steg = (nr, tittel, verdi, undertekst) => {
    const status = nr < ferdig || (nr === ferdig && nr < 2 && m) ? "ok"
                 : nr === ferdig ? "gaar" : "vent";
    const merke = status === "ok" ? "&#10003;" : "";
    return `
    <div class="steg">
      <div class="prikk prikk-${status}">${merke}</div>
      <div class="kol" style="gap:3px;flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
          <span style="font-size:16px;color:${status === "vent" ? "#5a5a5a" : "#ededed"}">${tittel}</span>
          ${verdi ? `<span class="mono" style="font-size:15px;color:${status === "ok" ? "#4ade80" : "#6b6b6b"};flex-shrink:0">${verdi}</span>` : ""}
        </div>
        ${undertekst ? `<div style="font-size:13px;color:#6b6b6b;line-height:1.4">${undertekst}</div>` : ""}
      </div>
    </div>`;
  };

  return `
  <div class="kol" style="gap:16px;height:100%">
    <div class="rad">
      ${avatar()}
      <div class="boble boble-ai">${S.klar ? "Ferdig. Se hva det kostet." : "Jobber med det. Du kan se hva jeg gjør."}</div>
    </div>

    <div class="kol" style="gap:5px;padding:6px 16px 10px;background:#111;border:1px solid #282828;border-radius:12px">
      ${steg(0, `Åpner ${esc(S.side.navn)}`, m ? `${(m.hentet_ms / 1000).toFixed(1)} s` : "", "henter siden slik en maskin får den")}
      ${steg(1, "Leser hele siden", m ? `${tall(m.raa_tegn)} tegn` : "", "kode, menyer, cookie-banner, reklame — alt")}
      ${steg(1, "Plukker ut selve teksten", m ? `${tall(m.reint_tegn)} tegn` : "", "det du faktisk leser med øynene")}
      ${steg(2, "Spør modellen med begge versjonene", "", "samme spørsmål, to ulike sider")}
    </div>

    ${m ? `<div class="kol inn" style="gap:7px;padding:13px 15px;background:#0e0e0e;border:1px solid #1e3a24;border-radius:11px">
      <div class="lbl" style="font-size:11px">Dette fant den</div>
      <div style="font-size:14px;color:#cfcfcf;line-height:1.45">«${esc(m.utdrag)}…»</div>
    </div>` : ""}

    ${m ? `<div style="text-align:center;font-size:15px;color:#9a9a9a;line-height:1.45">
      Den leste <span class="mono" style="color:#f97316">${tall(m.raa_tegn)}</span> tegn
      for å finne <span class="mono" style="color:#4ade80">${tall(m.reint_tegn)}</span>.
    </div>` : ""}

    ${S.klar ? `
    <div class="kol" style="gap:11px;margin-top:auto;flex-shrink:0">
      <div class="btn inn" data-handling="tilResultat">
        <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Neste</span>
      </div>
    </div>` : `
    <div style="margin-top:auto;height:5px;background:#1c1c1c;border-radius:999px;overflow:hidden">
      <div class="skyv" style="height:100%;background:#f97316;border-radius:999px"></div>
    </div>`}
    <div style="text-align:center;font-size:13.5px;color:#6b6b6b">${
      S.klar ? "Ingen tall er gjettet. Alt du ser er målt."
      : f === "sender" ? "Den store versjonen tar lengst tid."
      : "Ingen tall er gjettet. Alt du ser er målt."
    }</div>
  </div>`;
}

function s3() {
  const { raa, rein } = S.resultat;
  const forhold = raa.input_tokens / rein.input_tokens;
  const bredde = Math.max(0.6, (rein.input_tokens / raa.input_tokens) * 100);
  const meter = Math.round(forhold);
  return `
  <div class="kol" style="gap:14px;height:100%">
   <div class="kol" style="gap:16px;overflow-y:auto;flex:1;min-height:0">
    <div class="kol" style="gap:7px">
      <div class="lbl" style="color:#f97316">Steg 2 av 3</div>
      <div class="disp" style="font-size:27px;font-weight:700;line-height:1.15">To svar, to helt ulike regninger</div>
      <div style="font-size:14.5px;color:#9a9a9a;line-height:1.45">Samme spørsmål, stilt to ganger. Om svarene ble like gode dømmer du — ikke vi.</div>
    </div>
    <div class="kol" style="gap:9px">
      <div class="kol" style="gap:5px;padding:13px 15px;background:#141414;border:1px solid #282828;border-left:3px solid #f97316;border-radius:10px">
        <div class="fin" style="color:#f97316">Svar etter å ha lest alt</div>
        <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">«${esc(S.visSvar ? raa.answer : raa.answer.slice(0, 150) + (raa.answer.length > 150 ? " …" : ""))}»</div>
      </div>
      <div class="kol" style="gap:5px;padding:13px 15px;background:#141414;border:1px solid #282828;border-left:3px solid #4ade80;border-radius:10px">
        <div class="fin" style="color:#4ade80">Svar etter bare teksten</div>
        <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">«${esc(S.visSvar ? rein.answer : rein.answer.slice(0, 150) + (rein.answer.length > 150 ? " …" : ""))}»</div>
      </div>
      ${raa.answer.length > 150 || rein.answer.length > 150 ? `<div class="fin" data-handling="visSvar" style="color:#818cf8;cursor:pointer">${S.visSvar ? "Vis mindre" : "Les hele svarene"}</div>` : ""}
    </div>
    <div class="kol" style="gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <span style="font-size:15px;color:#ededed">Alt AI-en måtte lese</span>
        <span class="mono disp" style="font-size:22px;font-weight:500;color:#f97316">${tall(raa.input_tokens)} <span style="font-size:14px;color:#9a9a9a">tokens</span></span>
      </div>
      <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:100%;height:100%;background:#f97316"></div></div>
      <div class="fin">kode, menyer, reklame og cookie-bannere — alt som ligger bak siden</div>
    </div>
    <div class="kol" style="gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <span style="font-size:15px;color:#ededed">Selve teksten på siden</span>
        <span class="mono disp" style="font-size:22px;font-weight:500;color:#4ade80">${tall(rein.input_tokens)} <span style="font-size:14px;color:#9a9a9a">tokens</span></span>
      </div>
      <div style="height:36px;background:#1c1c1c;border-radius:7px;overflow:hidden"><div style="width:${bredde}%;min-width:7px;height:100%;background:#4ade80"></div></div>
      <div class="fin">artikkelteksten alene, uten menyer, reklame og kode</div>
    </div>
    <div style="display:flex;align-items:center;gap:14px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
      <div class="mono disp" style="font-size:38px;font-weight:500;line-height:1;color:#fb923c;flex-shrink:0">${forhold < 10 ? forhold.toFixed(1) : Math.round(forhold)}×</div>
      <div style="font-size:14.5px;color:#cfcfcf;line-height:1.45">så mye mer måtte AI-en lese enn selve teksten på siden<br><span style="color:#6b6b6b">tokens = tekstbitene den betaler for</span></div>
    </div>
    <div class="kol" style="gap:7px;padding:16px 17px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:15px;color:#ededed;line-height:1.5">Som å kjøre <b>${tall(meter)} meter</b> i elbil for å hente noe som ligger <b>én meter</b> unna.</div>
      <div class="fin">Et bilde på forholdet, ikke et energitall.</div>
    </div>
    ${S.malt && S.malt.raa_tegn && S.malt.reint_tegn ? `
    <div class="fin" style="line-height:1.5;margin-top:-6px">I tegn var forskjellen ${komma(S.malt.raa_tegn / S.malt.reint_tegn, 1)}×, i tokens ${komma(forhold, 1)}×. Kode og menyer deles opp i flere biter enn vanlig tekst, så regningen vokser raskere enn tekstmengden.</div>` : ""}
    ${raa.truncated ? `<div class="kol" style="gap:6px;padding:14px 16px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:14px;color:#ededed;line-height:1.45">Siden var for stor til å sendes hel. Vi sendte bare de første <span class="mono">${tall(raa.input_tokens)}</span> tekstbitene.</div>
      <div class="fin">Det ekte tallet er altså høyere enn det som står over.</div></div>` : ""}
   </div>
    <div class="btn" data-gaa="4" style="flex-shrink:0">
      <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Videre</span>
    </div>
  </div>`;
}

function s4() {
  const alt = ["Nettstedene — de burde være lettere å lese", "AI-selskapene — de burde lese smartere", "Begge to", "Det er greit som det er"];

  /* «Hvem burde gjøre noe med DETTE?» forutsetter at man husker tallet fra
   * forrige skjerm. Førsteårsstudenter som nettopp har sett ett tall én gang
   * gjør ikke nødvendigvis det, så vi gjentar funnet med deres egne tall og
   * sier hva som faktisk var i de tokenene. Uten måling: den generelle
   * formuleringen, aldri et oppdiktet tall. */
  const r = S.resultat;
  const forhold = r ? Math.round(r.raa.input_tokens / r.rein.input_tokens) : null;
  const forklaring = r
    ? `For å svare deg måtte assistenten lese <span class="mono" style="color:#fb923c">${tall(r.raa.input_tokens)}</span> tokens.
       Bare <span class="mono" style="color:#4ade80">${tall(r.rein.input_tokens)}</span> av dem var selve teksten på siden
       — resten var kode, menyer, sporingsskript og cookie-bannere.
       <b>${forhold} ganger mer enn selve teksten</b>, og det skjer på nytt hver gang noen spør.`
    : `En AI som skal svare om en nettside må lese alt som ligger bak den
       — kode, menyer, sporingsskript og cookie-bannere — ikke bare teksten du ser.
       Det koster strøm på nytt hver gang noen spør.`;

  return `
  <div class="kol" style="gap:16px;height:100%;overflow-y:auto">
    <div class="lbl" style="color:#f97316">Ett spørsmål til</div>
    <div class="disp" style="font-size:29px;font-weight:700;line-height:1.15">${SP2}</div>
    <div class="kol" style="gap:7px;padding:15px 16px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px;flex-shrink:0">
      <div class="lbl" style="font-size:12px">Det du nettopp så</div>
      <div style="font-size:14.5px;color:#cfcfcf;line-height:1.55">${forklaring}</div>
    </div>
    <div style="font-size:14.5px;color:#9a9a9a;line-height:1.5">Det finnes ikke noe fasitsvar. Vi vil vite hva du mener.</div>
    <div class="kol" style="gap:11px;flex-shrink:0;padding-bottom:4px">
      ${alt.map((a) => `<div class="svar" data-handling="svar2" data-verdi="${esc(a)}">${a}</div>`).join("")}
    </div>
  </div>`;
}

function s5() {
  /* Energien for AKKURAT denne økta: EcoLogits for svarene pluss det
   * FLOP-baserte leseestimatet, fra de samme feltene som lagres i basen.
   * Reserven 0,24 Wh gjelder bare økter uten energifelt — å vise den som
   * «ett spørsmål» ville motsagt storskjermen, som regner med lesingen.
   *
   * Alt oppgis i wattimer. Joule ble brukt her fordi sveiva målte joule, men
   * sveiva står nå ved fellesskjermen, og resten av standen regner i Wh. To
   * enheter for samme størrelse er én enhet for mye. */
  const r = S.resultat;
  const maalt = r ? (r.raa.energy_wh ?? 0) + (r.raa.lesing_wh ?? 0)
             + (r.rein.energy_wh ?? 0) + (r.rein.lesing_wh ?? 0) : 0;
  const wh = maalt > 0 ? maalt : 0.24;
  const tvS = (wh * 3600) / 100;
  const tvTekst = tvS >= 90 ? `${Math.round(tvS / 60)} minutter` : `${Math.round(tvS)} sekunder`;
  const batteri = wh / 11 * 100;
  return `
  <div class="kol" style="gap:18px;height:100%">
    <div class="kol" style="gap:8px">
      <div class="lbl" style="color:#f97316">Steg 3 av 3</div>
      <div class="disp" style="font-size:30px;font-weight:700;line-height:1.12">Dette kostet spørsmålet ditt</div>
    </div>
    <div class="kol" style="gap:6px;align-items:center;padding:22px;background:#111;border:1px solid #3a2412;border-radius:14px">
      <div style="display:flex;align-items:baseline;gap:9px">
        <div class="mono disp" style="font-size:${wh >= 100 ? 54 : 68}px;font-weight:500;line-height:1;color:#fb923c">${komma(wh)}</div>
        <div class="mono disp" style="font-size:26px;font-weight:500;color:#9a9a9a">Wh</div>
      </div>
      <div style="font-size:16px;color:#9a9a9a">strøm for ${maalt > 0 ? "spørsmålet ditt" : "ett spørsmål"}</div>
    </div>
    <div class="kol" style="gap:9px;padding:16px 17px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:15px;color:#ededed;line-height:1.5">Det er like mye strøm som <b>${tvTekst}</b> med TV-en på. Eller <b>${batteri < 1 ? batteri.toFixed(1) : Math.round(batteri)} %</b> av mobilbatteriet ditt.</div>
      <div class="fin">${maalt > 0
        ? "Regnet ut fra dine egne målte tall — både det å lese siden og det å svare. TV på 100 W, mobilbatteri på 11 Wh. Poenget er ikke at ett spørsmål er mye, men at det ikke er null, og at det meste gikk til å lese siden."
        : "TV på 100 W, mobilbatteri på 11 Wh, 0,24 Wh per forespørsel (Google, 2025 — median tekstforespørsel). Poenget er ikke at ett spørsmål er mye — det er hvor lite en kropp orker å lage."}</div>
    </div>
    ${rommetBoks()}
    <div class="btn" data-gaa="6" style="margin-top:auto">
      <span class="disp" style="font-size:20px;font-weight:700;color:#fff">Videre</span>
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

/* Sveiva står ved fellesskjermen, ikke her. Telefonen viser hva spørsmålet
 * kostet; produksjonen skjer et annet sted i rommet. Denne boksen er broen
 * mellom de to — den lover ikke et tall, den peker på et sted. */
function rommetBoks() {
  return `<div class="kol" style="gap:10px;padding:17px;background:#111;border:1px solid #1e3a24;border-radius:12px">
    <div class="disp" style="font-size:18px;font-weight:700;color:#4ade80">Vil du lage strømmen selv?</div>
    <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">Sveiva står ved den store fellesskjermen. Alt rommet sveiver går i samme pott, mot alt de to stasjonene har brukt til sammen.</div>
  </div>`;
}

/* «Du er nummer X i dag». spoersmaal teller unike session_id i ai_runs.
 * Sveivetallet står bevisst ikke her — det hører til fellesskjermen. */
function nummerBoks() {
  const t = S.totaler;
  if (!t) return "";
  return `<div class="kol" style="gap:10px;padding:17px;background:#111;border:1px solid #282828;border-radius:12px">
    <div style="font-size:14.5px;color:#cfcfcf;line-height:1.5">Du er nummer <span class="mono" style="color:#4ade80">${tall(t.spoersmaal)}</span> i dag.</div>
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
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Helt anonymt. Ingenting som kan identifisere deg er lagret — bare tallene og det du svarte.</div>

    ${r ? `<div class="kol" style="gap:12px;padding:18px 19px;background:#111;border:1px solid #282828;border-radius:12px">
      <div class="lbl">Din måling</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#9a9a9a">Alt AI-en måtte lese</span>
        <span class="mono" style="font-size:18px;color:#f97316">${tall(r.raa.input_tokens)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:14.5px;color:#9a9a9a">Selve teksten på siden</span>
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
    <div style="font-size:15px;color:#9a9a9a;line-height:1.5">Hvert sp\u00f8rsm\u00e5l standen stiller koster ekte penger: vi betaler for hver tekstbit AI-en leser. Det er ikke en feil \u2014 det er den samme regningen utstillingen handler om.</div>
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
      <div class="btn" data-gaa="4"><span class="disp" style="font-size:19px;font-weight:700;color:#fff">Se hva det har kostet i dag</span></div>
    </div>
  </div>`;
}

/* Artboard `Blokkert`. En side som svarer 403 er et funn, ikke en feil — og
 * kopien i designet sier nettopp det. */
function blokkert() {
  return `
  <div class="kol" style="gap:17px;height:100%">
    <div class="lbl" style="color:#fbbf24">Ingen tilgang</div>
    <div class="disp" style="font-size:29px;font-weight:700;line-height:1.15">Denne siden slapp ikke assistenten inn</div>
    <div class="mono" style="font-size:16px;color:#fbbf24">${esc(S.side.navn)} · HTTP ${S.feil.http_status ?? "403"}</div>
    <div class="kol" style="gap:9px;padding:16px 17px;background:#111;border:1px solid #282828;border-radius:11px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:15px;color:#ededed">Assistenten spurte</span>
        <span class="mono" style="font-size:16px;color:#fbbf24">Avvist</span>
      </div>
      <div style="font-size:14px;color:#9a9a9a;line-height:1.45">Serveren svarte ${S.feil.http_status ?? 403} før noe innhold ble sendt. Assistenten fikk aldri se siden.${S.side.avviser ? " Denne siden avviser alle automatiske forespørsler, ikke bare denne — det er ikke tilfeldig." : ""}</div>
    </div>
    <div class="kol" style="gap:7px;padding:16px 17px;background:#0e0e0e;border:1px solid #282828;border-left:4px solid #fbbf24;border-radius:10px">
      <div style="font-size:15.5px;color:#ededed;font-weight:600;line-height:1.4">Dette er ikke en feil i målingen</div>
      <div style="font-size:14px;color:#cfcfcf;line-height:1.5">En side som stenger ute alt som ikke ser ut som et menneske med nettleser, stenger også ute assistenten du ber om hjelp. «Tilgjengelig for mennesker» og «tilgjengelig for maskiner» er to forskjellige spørsmål — og bare det ene blir målt i dag.</div>
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
