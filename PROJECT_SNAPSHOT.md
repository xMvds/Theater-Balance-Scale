# Project snapshot (startcontext)

> Dit document is bedoeld als **overdraagbare startcontext** voor een nieuwe ChatGPT-chat of voor nieuwe ontwikkelaars/testers.

## 1. Projectoverzicht

### Doel en achtergrond

**Theater Balance Scale** (werknaam: **Balance 80**) is een realtime, browser-based party game voor lokale (en soms online) sessies met meerdere apparaten tegelijk. Spelers kiezen ieder een getal **0–100**. Het systeem berekent het gemiddelde en bepaalt het target via een vaste formule:

**Target = gemiddelde × 0.8**

De game is sterk **“cinematic”** in de reveal-fase (met name op het **Info-scherm**) met strakke timing, UI-animaties, score-updates en een gecontroleerde reveal-volgorde. Topprioriteit: **betrouwbare synchronisatie** tussen alle clients + **vloeiende UI** (geen knippen/layout shift, consistente reveal timing, stabiel op mobiel en desktop).

### Wat er gebouwd / ontwikkeld wordt

- **Node.js server (Express):**
  - serveert statische frontend
  - beheert centrale game-state (single source of truth)
  - realtime synchronisatie via sockets (socket.io-achtig)
- **Frontend:** vanilla HTML/CSS/JS (geen framework, snelle iteratie, geen build pipeline)
- **3 rollen/schermen:**
  - **Player (telefoon):** joinen, getal kiezen/confirm, scoreboard zien
  - **Host (laptop):** lobby beheren, rondes starten, reveal, next/reset, debug/settings
  - **Info (beamer/TV):** grote cinematic reveal animatie (leidend als hij open is)

### Gebruik / context

- Party-sessies in huiskamer/theater-setting
- Host + Info meestal op laptop/beamer; spelers op telefoon
- Soms ook online deployment getest (o.a. Render.com)
- Mobiel gedrag (tab/app background) is belangrijk: telefoon kan “slapen” of tabblad kan achtergrond zijn

## 2. Huidige status

### Wat werkt al (kernflow & stabiliteit)

- Basis gameflow: **lobby → collecting → revealed → next round → …**
- Server is centrale bron van waarheid:
  - clients krijgen na events een **full state snapshot**
- Unieke namen (case-insensitive) + auto naming (Speler 1/2/3…)
- 1 keuze per ronde (server enforced)
- Game over lock: bij 0–1 speler alive kan host niet door (alleen reset)
- Host kan later openen en ziet alsnog alle spelers/tiles
- Host/Info code gate UX aanwezig (client-side; vooral UX, niet echte security)
- Debug UX aanwezig:
  - host: “Kopieer debug”
  - player: hidden debug shortcut (o.a. 3× “d”)

### Wat gedeeltelijk werkt / is sterk verbeterd

- Reveal sync op basis van server-timestamps:
  - players/info kunnen “inhaken” mid-reveal op juiste tijdpositie
  - players die na reveal openen: skip reveal → direct scoreboard
- Player backgrounds:
  - banding/lag issues aangepakt met statische high-res achtergrond / FinisherHeader varianten
  - uiteindelijke default: FinisherHeader-config (“C”)
- host heeft settings-paneel met live background editor + reset naar basis
- Mobiele layout is gericht verbeterd, maar blijft het grootste UX-werkpunt (zie “Problemen”)

### Wat nog niet werkt / geeft problemen (open of nog te verifiëren)

- Mobiele scoreboard/reveal UI (telefoon) moet 100% netjes:
  - 4 tiles per rij (en 3 bij extreem smalle schermen)
  - namen boven tiles, score/delta onder tiles
  - geen overlap tussen rijen en geen misalignment bij wrapping
  - som/average/target moet passend zijn met voldoende marge
- Skip-flow / timing: bij skip van reveal moet UI direct correct doorpakken:
  - bij skip moet het “speelvak/scoreboard panel” direct open klappen (niet pas na normale animatie)
  - desktop timing moet exact intact blijven (telefoon-layout mag niet aan desktop-timing sleutelen)

## 3. Belangrijke beslissingen en keuzes

### Technische keuzes

- Node.js + Express server + static hosting
- Socket-based realtime synchronisatie
- Vanilla frontend (HTML/CSS/JS) om iteratie snel te houden

### Architectuur / aanpak

- Eén centrale state op server:
  - events muteren server-state
  - server broadcast full snapshot naar alle clients
- Clients renderen UI op basis van:
  - phase + round + playerdata + reveal flags
- Reveal driver model:
  - Info open → Info is driver
  - Info niet open → Player driver (players draaien reveal zelf)
- Reveal gating:
  - scoreboard bij players mag pas open na “reveal ready” (info done / reveal afgelopen / skip)

### Waarom deze aanpak

- Sync/debug eenvoudiger met centrale state
- Meerdere UIs (host/info/player) blijven consistent op 1 waarheid
- Timestamps + state snapshots lossen veel “late join / refresh” problemen op

## 4. Functionaliteiten en onderdelen

### A) Server (server.js)

**Doel**

- Serve /public
- Beheer lobby, rounds, submit, scoring, reveal timing, gating, game over
- Broadcast state naar alle clients

**Hoe het werkt**

Belangrijke events:

- join (name + playerKey)
- submit (1 keuze per ronde, enforced)
- host: host_start, host_reveal, host_next, host_reset
- info: info_hello, info_reveal_done
- sync request: client vraagt opnieuw full snapshot

Reveal:

- Server zet revealStartedAt, revealDurationMs, revealDriver
- Clients gebruiken serverNow offset om elapsed te berekenen

Gating:

- revealReadyRound (en soms revealReadyAt) bepaalt of scoreboard open mag
- “skip” betekent: revealReady for current round true maken

**Aandachtspunten**

- Reconnect/foreground: clients kunnen updates missen door mobiele throttling → sync/rejoin nodig
- Host “Next” moet:
  - altijd klikbaar blijven
  - visueel aangeven of reveal nog bezig is (rood) of klaar (groen)
  - tijdens reveal: eerste druk = skip/unlock, daarna pas round advance

### B) Player (index.html + client.js)

**Doel**

- Joinen met naam
- Getal kiezen in collecting en bevestigen
- In revealed: scoreboard panel openklappen wanneer reveal ready
- Indien player-driver: reveal animatie draaien zoals Info

**Hoe het werkt**

- UI driven door phase:
  - lobby/collecting: input
  - revealed: reveal overlay / scoreboard panel

Reveal sync:

- revealStartedAt + revealDurationMs + serverNow → elapsedMs
- bij late join: direct juiste stage (zonder animatie opnieuw te “replayen”)

Background/foreground robuustheid:

- visibilitychange/pageshow triggers:
  - timers resetten
  - UI catch-up “instant” render
  - sync request + (optioneel) join re-emit met playerKey

**Aandachtspunten**

- Scoreboard panel moet bij skip meteen open (geen wachten op oude timers)
- Mobiele layout van reveal-scoreboard (overlay) is kritisch: 4-per-rij + correct uitlijnen

### C) Host (host.html + host.js)

**Doel**

- Gameflow besturen
- Lobby beheer
- Debug/settings, waaronder background editor voor players

**Hoe het werkt**

Host toont:

- lobby players/connected/alive
- tijdens collecting live gemiddelde/target berekening
- in revealed: next/reset controls

Next knop UX:

- visueel rood zolang reveal/animaties nog lopen
- countdown met 0.1s updates (vloeiend: 1.0, 0.9, 0.8…)
- knop blijft altijd klikbaar (alleen indicator)
- bij klikken tijdens rood: skip effect (unlock), niet hard blocken

Settings-paneel rechtsonder:

- background editor (FinisherHeader config push naar players)
- reset naar basisconfig
- “Kopieer debug”

Build versie zichtbaar onderin host.

**Aandachtspunten**

- Host “Next” moet nooit per ongeluk de hele ronde doorzetten als bedoeling “skip reveal” is
- UI state moet consistent blijven na refresh/reconnect

### D) Info (info.html + info.js)

**Doel**

- Cinematic reveal animatie op groot scherm
- Driver wanneer open: bepaalt het moment dat players scoreboard mogen openen

**Hoe het werkt**

- info_hello handshake
- Reveal animatie stages op timestamps
- info_reveal_done wordt gestuurd wanneer reveal klaar is (of instant-skip)

Nieuwe regel aankondiging:

- In collecting, als een nieuwe regel “aan” gaat:
  - scherm fade naar zwart
  - tekst knipt in (geen fade-in)
  - blijft 3s
  - daarna fade zwart + tekst tegelijk uit (±5s)

**Aandachtspunten**

- Responsiveness op kleine screens (info op telefoon) moet clipping voorkomen
- Bij host-skip moet info-reveal kunnen “instant” naar eindstate (geen herstart/foute fades)

## 5. Belangrijke data, variabelen en parameters

### Routes / rollen

- Player: / of /index.html
- Host: /host.html (en/of /host)
- Info: /info.html (en/of /info)

### State (conceptueel)

- phase: lobby | collecting | revealed
- round: integer
- players: lijst/map met o.a.:
  - id/key, name, score, lastDelta, lastGuess
  - submitted, eliminated, connected
- lastRound: { average, target, winnerIds, ... }
- roundRules: flags:
  - duplicates invalid → -1
  - exact guessed → losers -2
  - 0 vs 100 special

Reveal sync:

- revealDriver: "info" of "player"
- revealStartedAt (server timestamp)
- revealDurationMs
- serverNow (voor clock offset clients)
- revealReadyRound + revealReadyAt

### Kernformule

- target = average * 0.8

### Default player background (FinisherHeader basisconfig “C”)

```json
{
  "count": 7,
  "size": { "min": 298, "max": 506, "pulse": 0.19 },
  "speed": { "x": { "min": 0, "max": 0.06 }, "y": { "min": 0, "max": 0.1 } },
  "colors": { "background": "#0b0d12", "particles": ["#2e2f33"] },
  "blending": "screen",
  "opacity": { "center": 0.09, "edge": 0 },
  "skew": 0,
  "shapes": ["c"]
}
```

### Access code gate (UX)

- Host/Info prompt-code (bijv. 0909) om die UI te openen (client-side UX gate)

## 6. Problemen en bugs (met status)

### 6.1 Tab/app background → UI blijft hangen / mist updates

**Omschrijving:** na terugkomen van achtergrond (telefoon uit, tab background) blijft player/host soms hangen op oude fase/UI tot refresh.

**Wanneer:** vooral Android/iOS door throttling/bfcache/visibility.

**Wat geprobeerd / aanpak:**

- visibilitychange + pageshow(persisted) → sync forceren
- timers annuleren en UI “instant” catch-up renderen
- (optioneel) join opnieuw emitten met playerKey op foreground

**Status:** grotendeels verbeterd; resterende issues zitten vooral in rand-timing (fades die opnieuw kunnen triggeren als je precies mid-anim terugkomt).

### 6.2 Mobiele scoreboard/reveal UI (overlay) niet netjes

**Omschrijving:** tiles/namen/scores wrappen niet consistent; rijen 2+ misalignen; naam/score/delta niet bij juiste tile; som te breed.

**Gewenst:**

- 4 tiles per rij (3 bij ultra-small)
- per speler: Naam boven tile, daarna Score, daarna Delta
- genoeg verticale spacing tussen rijen
- math row kleiner, met marge naar schermrand

**Status:** in iteratie; implementatie richting “per-player card grid” om wrap-misalignment te voorkomen.

### 6.3 Skip reveal → scoreboard panel moet direct openklappen

**Omschrijving:** als reveal animatie geskipt wordt, moet het scoreboard panel (onder de cijfer-grid op player) meteen openen. Als reveal normaal eindigt opent het wel.

**Oorzaak (conceptueel):** “Next” event dat te vroeg doorfaseert of gating/timers die pas op normaal einde openen.

**Status:** vereist strikte scheiding tussen:

- “skip/unlock huidige reveal”
- “advance naar volgende ronde”

### 6.4 Host Next knop feedback & gedrag

**Omschrijving:** Next moet rood zijn als animatie loopt, groen als klaar, maar altijd klikbaar.

**Extra wens:** countdown in stappen van 0.1s; bij drukken tijdens countdown → skip reveal; daarna groen “Next”.

**Status:** UX-gedrag is leidend; server/clients moeten het consistent ondersteunen.

### 6.5 Dead screen timing + overlay (gebroken glas)

**Omschrijving:**

- dead screen moet pas verschijnen als scoreboard/unfold ver genoeg is, maar nét iets eerder dan volledig einde.
- overlay: “broken glass” effect over dead screen, liefst generated en scherp (geen pixelige PNG).

**Status:** timing fine-tuning blijft gevoelig i.v.m. fades; overlay design iteratief.

### 6.6 Nieuwe regels aankondigen op player wanneer Info niet open is

**Omschrijving:** als Info niet open is, moeten regels ook op player aangekondigd worden (zelfde gedrag als Info).

**Gewenst gedrag:**

- scherm fade zwart
- tekst knipt in
- 3s blijven
- daarna fade zwart + tekst tegelijk uit (~5s)

**Status:** aanwezig, maar moet ook robuust werken bij background/foreground (queued en tonen bij terugkomst).

## 7. Gebruikerswensen en eisen

### Functioneel

1. 1 keuze per ronde (server enforced)
2. Unique names + auto naming
3. Refresh mid-game = auto rejoin met key/naam
4. Lobby refresh vóór start = speler echt eruit
5. Game over lock (alleen reset)
6. Info kan later openen en inhaken in reveal
7. Player kan na reveal openen → reveal skip → direct scoreboard

### UI/UX

- Smooth transitions; geen knip/layout shift
- Scoreboard pas zichtbaar na reveal-ready
- Player reveal zonder info moet exact dezelfde reveal als info hebben
- Mobile-only aanpassingen via media queries (desktop uiterlijk blijft goed)
- Host Next indicatie (rood tijdens reveal, groen als klaar), maar knop blijft klikbaar

### Performance & stabiliteit

- Banding vermijden (o.a. door statische high-res backgrounds / subtiele effecten)
- Betrouwbare state-sync bij mobiele background/foreground switches

### Packaging & versiebeheer

- Releases bevatten altijd README.md + LICENSE
- ZIP bevat alleen balance80-game/ (geen work-mappen)
- Versies starten bij v3 en blijven onder v4.0 (bijv. v3.0.0.xx)

## 8. Openstaande vragen / volgende stappen

- Mobiele reveal-scoreboard overlay definitief afmaken:
  - 4 per rij / 3 bij ultra-small
  - naam boven tile; score + delta onder tile
  - math row smaller + meer marge
- Skip-flow eindtesten:
  - skip = unlock huidige reveal + direct openklappen scoreboard panel
  - daarna pas echte “next round” bij volgende Next
- Dead screen timing verder finetunen zonder flicker met scoreboard fades
- Rules overlay:
  - queued gedrag bij background/foreground betrouwbaar maken
  - op Info en Player exact hetzelfde gedrag
- Extra QA op:
  - iOS Safari bfcache (pageshow persisted)
  - Android throttling
  - snelle reconnects / meerdere state broadcasts

## 9. Belangrijke context voor toekomstige chats

### Terminologie

- Collecting: spelers kiezen getal
- Revealed: scores berekend en reveal/scoreboard tonen
- Reveal driver: "info" of "player"
- Reveal ready: moment dat scoreboard open mag (revealReadyRound === round)
- Inhaken: later openen van info/player tijdens reveal → juiste stage op basis van timestamps
- Skip reveal: player opent na reveal of host drukt skip → direct eindstate/scoreboard

### Aannames die niet opnieuw hoeven

- Target formule is altijd average * 0.8
- Regels 1–3 zijn vaste teksten
- Server is single source of truth; clients renderen uit full snapshots
- Desktop UI is al goed; mobile fixes moeten mobile-only blijven

### Belangrijk om te onthouden

- Player background default = FinisherHeader config “C” (basis JSON)
- Host settings-paneel rechtsonder: BG editor + kopieer debug
- ZIP/README/LICENSE + versioning regels blijven gelden

## 10. Korte samenvatting (1 alinea)

Balance 80 (Theater Balance Scale) is een realtime browser party game met drie rollen (Player/Host/Info) op Node.js + sockets en vanilla frontend. Spelers kiezen 0–100; target is altijd gemiddelde × 0.8. De reveal-fase is cinematic en tijd-gesynchroniseerd via server timestamps zodat late joins en refreshes kunnen “inhaken” zonder timing te verliezen. De server broadcast full state snapshots; gating via revealReadyRound bepaalt wanneer players het scoreboard mogen openen. Grote focus ligt op stabiele mobile foreground/background resync en een perfecte mobiele layout van de reveal-scoreboard animatie (4 tiles per rij, naam boven tile, score/delta onder tile), plus host “Next” feedback (rood tijdens animatie, groen als klaar, maar altijd klikbaar). Releases moeten altijd README+LICENSE bevatten en versies blijven binnen v3.x.
