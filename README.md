# Agent-avgiften — web

Telefonflyten og storskjermen for standen. Statiske filer og en avhengighetsfri
Node-server, bygget for å bli auto-deployet av Railway ved push til `main`.

    /            telefonflyten  (QR-koden peker hit)
    /skjerm/     storskjermen   (fullskjerm på projektorlaptopen)

Andre stasjon: `/?stasjon=medstudent`

## Hvorfor et eget repo

Måledelen — migrasjoner, Edge-funksjonen `ask`, etterprøvingen — ligger i
`agent-avgiften-stand`. Den skal ikke deployes noe sted. Dette repoet er bare
det som skal serveres, så Railway kan bygge det uten å se resten.

## Hemmeligheter

Ingen. `config.js` inneholder Supabase **anon**-nøkkelen, som er offentlig av
design — RLS er det som beskytter dataene, og det er etterprøvd: anon får
HTTP 401 på alle tabeller og kan kun sette inn.

OpenAI-nøkkelen er aldri her. Den ligger som secret i Supabase Edge-funksjonen,
og telefonen snakker direkte med den. Denne serveren er aldri i den veien og
leverer bare filer.

## Lokalt

```bash
npm start
# http://localhost:3000
```

## QR-koden

Når Railway har gitt deg en adresse, generer QR-en i det andre repoet og kopier
den hit:

```bash
cd ../stand && node verify/lag-qr.mjs https://<app>.up.railway.app/
cp web/skjerm/qr.svg ../stand-web/public/skjerm/qr.svg
```

## Deploy

Auto-deploy til GitHub Pages ved push til `main`
(`.github/workflows/pages.yml`). Ingen manuelle steg.

    https://halvorhetland.no/agent-avgiften-web/          telefonen
    https://halvorhetland.no/agent-avgiften-web/skjerm/   storskjermen

**Cache.** Pages serverer med `max-age=600`. Workflowen stempler commit-SHA
inn i alle script-tagger, så ny kode alltid er en ny URL. Selve HTML-en kan
likevel ligge inntil ti minutter i nettleserens cache — åpner du skjermen rett
etter en deploy på standdagen, gjør en hard reload.

**Skalering.** Skjermen skaleres med `ResizeObserver`, ikke bare `resize`. En
projektor som kobles til bytter oppløsning uten at `resize` alltid fyrer, og
uten dette blir flata stående på laptopskjermens mål.

### Hvorfor ikke Supabase Storage

Prøvd og forkastet. Storage tvinger `content-type: text/plain` og
`content-security-policy: default-src 'none'; sandbox` på alt den serverer —
med vilje, så ingen kan hoste kjørende kode på supabase.co. Sidene lastet, men
vistes som kildekode og all JavaScript var blokkert.

### Hvorfor ikke Railway

Prøveperioden var utløpt og det krevde et betalt abonnement. Pages er gratis og
gir samme auto-deploy. Handoffens «no Railway» gjaldt uansett noe annet — at
API-nøkkelen bare skal finnes ett sted — og statisk filhosting bryter ikke den
regelen.
