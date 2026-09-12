# Build log

Running record of what actually works, checkpoint by checkpoint.

---

## Step 1 — Gated action with plain CAPTCHA blocking (no blockchain) ✅

**Goal:** prove the baseline. A raw bot script gets blocked; a human gets through.
If this half is not real, letting vouched agents past later proves nothing.

**What exists**

| Piece | Path |
| --- | --- |
| Gate decision engine | `backend/src/lib/gate.js` |
| CAPTCHA challenge logic | `backend/src/lib/challenge.js` |
| PNG renderer (no native deps) | `backend/src/lib/captcha-image.js` |
| Demo state + live event log | `backend/src/lib/state.js` |
| Vouch resolution (placeholder) | `backend/src/lib/vouch.js` |
| HTTP surface | `backend/src/server.js` |
| Demo drop page | `backend/public/` |
| Anonymous bot | `bots/raw-bot.js` |

**Demo scenario:** ETHOnline 2026 Founders Pass, 50 units, one per person.
A counter makes scarcity legible at a glance, so the later scope cap
("this agent may claim 1") reads without explanation.

**Verified**

Bot run — 4 strategies, 0 claims, inventory untouched at 50:

1. Bare `POST /api/claim` → `challenge_required`
2. Fetch challenge, guess the code → `challenge_failed` (0ms solve time)
3. Forge behaviour signals, brute-force 4 guesses → `challenge_failed`, challenge burned
4. Present an invented vouch name → `vouch_unknown`, treated as anonymous

Human run in a real browser — read the warped image, typed the code, claimed
pass #2. Counter went 50 → 48 across two runs. Both paths appear in the live
gate log with their reason codes.

**Design notes**

- The challenge image is rasterised to PNG server-side by hand. Shipping it as
  SVG or JSON would let a bot read the answer out of the payload, making the
  "blocked" beat theatre. Solving it needs OCR.
- Behavioural signals (solve time, pointer-movement samples) are checked before
  the answer, so a script that never opened a browser fails earlier and for a
  more honest reason.
- `vouch.js` returns "not found" for everything and contains **no hard-coded
  demo vouches**. ENS's track rules require live resolution; there is nothing to
  rip out later.

**Bug fixed during verification:** `.modal` had `display:grid`, which overrides
the `hidden` attribute, so the dialog stayed up after a successful claim.

---

## Step 2 — World Selfie Check (human path) — next
