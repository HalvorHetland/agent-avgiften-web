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
