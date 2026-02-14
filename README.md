# Balance 80 (Theater Balance Scale)

A real‑time, browser-based party game inspired by **“Balance Scale”** from *Alice in Borderland*.

> The same game as "Balance Scale" in Alice in Borderland including a Host Screen, Player Screen and Info screen.  
> The game was made by chatGPT I have no code skills and hope you can try the game yourself

Players pick a number from **0–100**. After everyone confirms, the game reveals results with a cinematic animation and updates scores.

---

## Screens

- **Player**: join the lobby, pick a number, confirm, view the scoreboard  
- **Host**: start rounds, trigger reveal, go to next round, reset the game  
- **Info**: “presentation” screen (TV / beamer) that runs the reveal animation

---

## Game rules (core)

- Each round, every player chooses **one** number (0–100) and confirms (locked for that round).
- The game computes:
  - **Average** = average of all confirmed numbers  
  - **Target** = `Average × 0.8`
- The **winner** is the player whose number is closest to the target.
- Extra rules (may activate depending on player count / round settings):
  1. Duplicate numbers are invalid and give **-1** point.
  2. Exact guesses give the losers **-2** points.
  3. If one player chooses **0**, another wins by choosing **100**.

---

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open in your browser:
   - Player: `http://localhost:3000/`
   - Host: `http://localhost:3000/host`
   - Info: `http://localhost:3000/info`

---

## Access code (Host / Info)

Host and Info can be protected by an access code prompt.  
If you want to change the code, check:
- `public/host.js`
- `public/info.js`

---

## Project structure

- UI (HTML/CSS/JS): `public/`
- Server + game state: `server.js`

---

## License

See the **LICENSE** file in this repository.
