# 🎭 Guess Whoo!

A colourful, two-player **Guess Who**–style deduction game that runs entirely in
the browser. No server of its own, no build step. Play **online** with a friend
using a shared room code, **pass-and-play** on one device, or take on the
**robot**.

> 30 characters · pick **20** for your board · choose **1** secret · out-deduce your rival.

---

## How to play

1. **Build your board.** Each player picks **20** of the 30 characters. This is
   the board your opponent studies.
2. **Choose your secret.** Pick **1** of your 20 to be your hidden character ⭐.
3. **Take turns.** On your turn, ask a yes/no question about a trait (hair, hat,
   glasses, and so on), then do **one** of:
   - 🚫 **Disable** the characters that don't fit. A pop-up confirms this,
     because once you start disabling you **can't guess this turn**.
   - 🎯 **Guess** the opponent's secret. Right means **you win** 🏆. Wrong means
     **you lose**.
4. **Read the room.** The scoreboard shows how many of your cards are still
   active, and the activity log shows how many your opponent crossed off each
   turn. You can undo your own crossings-off while the turn is still yours.
5. Hit **End Turn** to pass play. First correct guess wins.

When the game ends, both players get the full log: every question, answer and
chat line with who sent it and when, the cards each player crossed off with
pictures, and the trait those cards had in common.

## Play modes

| Mode | How it works |
| --- | --- |
| 🌍 **Online** | One player hosts and gets a 4-letter room code. The other joins with the code, or picks the room from the list of open rooms. The host approves them before the game starts. |
| 🛋️ **Pass & Play** | Both players share one device, with "look away" screens between hand-offs so secrets stay secret. |
| 🤖 **Play a Robot** | Solo, against a computer opponent at easy, medium or hard. Hard picks questions that split the remaining cards as evenly as it can, and only guesses when it is sure. |

## Characters and traits

Every character is a unique mix of askable traits, so the deduction stays
faithful to the classic game:

- **Hair colour**: black, brown, blonde, red, gray, blue, pink, green
- **Hair style**: bald, short, long, curly, spiky, bun, mohawk, afro
- **Eye colour**: brown, blue, green
- **Skin tone**: light, tan, brown, deep
- **Glasses**: none, round, square, sunglasses
- **Headwear**: none, cap, beanie, top hat, crown, party hat
- **Facial hair**: none, mustache, beard, goatee
- **Accessory**: none, earrings, bow tie, necklace, scarf, freckles

The avatars are drawn procedurally as inline SVG (in `js/characters.js`), so
they're crisp at any size and add zero image weight.

---

## Run locally

The app uses ES modules, so open it through a local web server rather than
`file://`:

```bash
# from the repo root
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

It is a static site, so any web host will do. Copy the files up and serve them
over HTTPS. Every path in the page is relative, so it works just as well from a
sub-folder like `https://example.com/guess_who/`.

Room codes are global, so two players on different copies of the site can still
find each other, as long as both copies are the same version.

### GitHub Pages

**A. GitHub Actions (already configured)**
1. Merge or push to the `main` branch.
2. Go to **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) deploys automatically.

**B. Deploy from a branch**
1. Go to **Settings → Pages → Source**, then **Deploy from a branch**.
2. Choose your branch and the **/(root)** folder, then **Save**.

Your site will be live at:

```
https://<your-username>.github.io/guess_who/
```

(An empty `.nojekyll` file is included so GitHub Pages serves the `js/` folder
as-is.)

---

## How online play actually connects

This is the fiddliest part of the project, so it is worth knowing how it works
before changing any of it.

**First choice: a direct connection between the two browsers**, using WebRTC
through [PeerJS](https://peerjs.com/). The library is vendored locally, but
setting up a connection still goes through PeerJS's public signalling server to
swap connection details. Once the two browsers are talking, that server is out
of the picture, and no gameplay data passes through it. This path is encrypted
end to end.

Plenty of ordinary networks have no route between two browsers, though. Wi-Fi
with client isolation turned on, mobile data behind carrier-grade NAT, and
anything that blocks UDP will all fail. The usual cure is a TURN relay, and
PeerJS ships with two of them built in, but both hosts stopped resolving in DNS
some time ago, and there is no free relay left that works without an account.

**So when a direct connection doesn't come up within a few seconds, the game
falls back to a relay over ordinary HTTPS on port 443**, which just about every
network allows. Each room gets two public topics on [ntfy.sh](https://ntfy.sh),
one carrying messages to the host and one to the guest. The game tells you on
screen when it is using the relay.

**Worth knowing if you use the relay:** messages go through a public service and
anyone who knows the room's topic can read them. That includes display names and
chat. Direct play has no such exposure. If you would rather not rely on a public
service at all, run your own ntfy instance and point the game at it by setting
`window.__GW_RELAY_BASE` before `js/app.js` loads. That also sidesteps the rate
limits below.

**Rate limits.** ntfy.sh allows roughly 60 requests per 5 minutes and 250
published messages per day **per IP address**, and two players behind the same
router share that budget. The game is built to stay well inside it: rooms are
announced when something changes rather than on a timer, a browser opening the
room list asks once instead of every host broadcasting continuously, and retries
are few and spaced out. If you ever do get throttled, the game says so rather
than quietly doing nothing.

**Room discovery** works the same way. There is no coordinator and nothing to
elect: hosts announce their room on one shared topic, every browser listens, and
a host that goes away simply stops answering and ages out of the list. Joining
by code never needs the list at all.

**Delivery.** Neither transport guarantees a message arrives, and six of the
engine's messages hand control from one player to the other, so losing one would
leave both players waiting forever. `js/reliable.js` numbers every message, has
the receiver confirm what it has, and resends anything unconfirmed. In the normal
case confirmations ride along on the reply and cost nothing extra.

If both paths fail, **Pass & Play** and the **robot** work with no network at
all.

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
  reliable.js          # numbers messages and resends anything unconfirmed
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

Quote the glob so Node expands it, and so it matches only `*.test.mjs`. The
fakes beside them are helper modules, not test files, and Node will fail if it
tries to run them as tests.

Nothing to install first, since the game has no dependencies and no build. The
same command runs on every pull request and on anything landing on `main`
(`.github/workflows/tests.yml`). `main` deploys straight to GitHub Pages, so
that run is the only gate between a change and the live site.

The transports are tested against in-memory fakes, which covers the message
handling but says nothing about real networks. Anything to do with whether two
browsers can actually reach each other needs two real devices to test.

## Troubleshooting online play

If a room won't connect, open **Connection details** underneath the room code or
the Join button. It reports which transport is in use, the state of the direct
connection, which relay topics are in play, whether the subscription is live,
and whether any messages were rate-limited. That is usually enough to tell a
wrong room code apart from a network that blocks peer-to-peer apart from a
service that is throttling you.
