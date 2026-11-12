# 🎭 Guess Whoo!

A colourful, two-player **Guess Who**–style deduction game that runs entirely in
the browser — no server, no build step. Play **online** with a friend using a
shared room code, or **pass-and-play** on a single device.

> 30 characters · pick **20** for your board · choose **1** secret · out-deduce your rival.

---

## How to play

1. **Build your board.** Each player picks **20** of the 30 characters. This is
   the board your opponent studies.
2. **Choose your secret.** Pick **1** of your 20 to be your hidden character ⭐.
3. **Take turns.** On your turn, ask a yes/no question about a trait (hair, hat,
   glasses, …), then do **one** of:
   - 🚫 **Disable** — cross out the characters that don't fit. A pop-up confirms
     this, because once you start disabling you **can't guess this turn**.
   - 🎯 **Guess** — name the opponent's secret. Right = **you win** 🏆. Wrong = **you lose**.
4. **Read the room.** After every turn you can see how many cards your opponent
   has left **open** vs **crossed out**.
5. Hit **End Turn** to pass play. First correct guess wins!

## Play modes

| Mode | How it works |
| --- | --- |
| 🌍 **Online** | One player hosts and gets a 4-letter room code; the other joins with it. Uses WebRTC (peer-to-peer) — no gameplay data touches a server. |
| 🛋️ **Pass & Play** | Both players share one device, with "look away" screens between hand-offs so secrets stay secret. |

## Characters & traits

Every character is a unique mix of **askable traits**, so the deduction stays
faithful to the classic game:

- **Hair colour** — black, brown, blonde, red, gray, blue, pink, green
- **Hair style** — bald, short, long, curly, spiky, bun, mohawk, afro
- **Eye colour** — brown, blue, green
- **Skin tone** — light, tan, brown, deep
- **Glasses** — none, round, square, sunglasses
- **Headwear** — none, cap, beanie, top hat, crown, party hat
- **Facial hair** — none, mustache, beard, goatee
- **Accessory** — none, earrings, bow tie, necklace, scarf, freckles

The avatars are drawn procedurally as inline SVG (in `js/characters.js`), so
they're crisp at any size and add zero image weight.

---

## Run locally

Because the app uses ES modules, open it through a local web server (not
`file://`):

```bash
# from the repo root
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

Two options — pick one:

**A. GitHub Actions (recommended, already configured)**
1. Merge/push to the `main` branch.
2. Go to **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) deploys automatically.

**B. Deploy from a branch**
1. Go to **Settings → Pages → Source** → **Deploy from a branch**.
2. Choose your branch and the **/(root)** folder, then **Save**.

Your site will be live at:

```
https://<your-username>.github.io/guess_who/
```

(An empty `.nojekyll` file is included so GitHub Pages serves the `js/` folder as-is.)

---

## Project layout

```
index.html             # markup + screens
styles.css             # colourful, responsive styling
js/
  characters.js        # 30-character roster + procedural SVG avatars
  engine.js            # pure, testable game state machine
  ai.js                # the robot opponent's decision making
  loganalysis.js       # deduction summaries for the end-of-game log
  net.js               # direct WebRTC (PeerJS) transport + local pass-and-play
  relay.js             # HTTPS fallback transport, for networks WebRTC can't cross
  channel.js           # picks between them: direct first, relay if that fails
  lobby.js             # room discovery (a broadcast feed, no server of our own)
  app.js               # UI rendering + orchestration
  vendor/peerjs.min.js # vendored PeerJS (no runtime CDN dependency)
tests/
  *.test.mjs           # unit tests (node --test)
  fake-peer.mjs        # in-memory stand-in for the PeerJS broker
  fake-ntfy.mjs        # in-memory stand-in for the relay service
```

## Tests

```bash
node --test "tests/**/*.test.mjs"
```

Quote the glob so Node expands it, and so it matches only `*.test.mjs` — the
fakes beside them are helper modules, not test files.

No dependencies and no build step, so there is nothing to install first. The
same command runs on every pull request and on anything landing on `main`
(`.github/workflows/tests.yml`); `main` deploys straight to GitHub Pages, so
that run is the only gate between a change and the live site.

## Notes on online play

Online mode uses [PeerJS](https://peerjs.com/) over WebRTC. The library is
vendored locally, but establishing a peer connection still uses PeerJS's public
signalling server to exchange connection details (no gameplay data passes
through it). If two players are on very restrictive networks that block WebRTC,
fall back to **Pass & Play**.
