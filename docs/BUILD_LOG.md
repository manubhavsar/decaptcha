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

**Status:** backend plumbing complete and unit-tested (8 tests). Blocked on two
World approvals that are not self-serve — the Selfie Check feature flag and
sandbox tester access. See `docs/WORLD_INTEGRATION_NOTES.md`.

What is written and waiting on credentials: RP request signing, request
creation with the `selfieCheckLegacy` preset, polling, portal verification, and
nullifier replay protection. Three environment variables away from running.

---

## Step 3 — ENSv2 vouches on Sepolia (read path ✅, write path next)

**Verified live**

- All twelve ENSv2 contract addresses checked with `eth_getCode` on chain
  (`scripts/preflight.js`), not trusted from a table.
- Resolution round-trips against Sepolia in roughly 300-600ms with no cache.
- Names that do not exist return no resolver; `test.eth` resolves but is
  correctly reported as *not a vouch* because it carries no scope record.
- `decaptcha.eth` is available on ENSv2 Sepolia and is the intended parent.

**Design**

See `docs/ENS_ARCHITECTURE.md`. The load-bearing find is that
`PermissionedResolver` scopes Enhanced Access Control resources to
`keccak256(node, part)` — a name *and* a record type — so the human can hold
write permission on one specific record of one specific vouch while the agent
holds nothing anywhere.

**Traps recorded**

- Two ENSv2 deployments are live on Sepolia simultaneously. The `deployments/`
  folder on contracts-v2 `main` is older than the set the docs pin, and both
  have bytecode, so picking wrong fails late.
- Registration is commit/reveal and priced in an ERC20, not ETH. On Sepolia the
  payment token is a mock whose `mint` is public, so it costs nothing real.

**Next:** register the parent name, then mint a vouch subname with its own
Permissioned Resolver and Enhanced-Access-Control-gated writes. Needs a funded
Sepolia burner key.

### decaptcha.eth registered ✅

Live on ENSv2 Sepolia.

| | |
| --- | --- |
| Name | `decaptcha.eth` |
| Owner | `0xF3c024c70De326C14296A4D74fc4Be9aB817265C` |
| Child registry | `0xCd55B677A38A89804c84677EaFB789eCd876c0ef` |
| Registration tx | `0xaa1cbcf5a2ed0ef1603bcb2188748d7aac3817b4086532abdf664877d4456b4d` |
| Term | 1 year |

The parent is registered with **no resolver of its own**, deliberately. Each
vouch subname gets its own Permissioned Resolver at mint time, which is what
makes a vouch self-owned rather than a row in a shared table.

Two things the registrar demanded that the docs did not lead with:

- Registration is **commit/reveal** with a 60s minimum commitment age, so the
  script has to wait between two transactions.
- Payment is in an **ERC20**, and the price oracle's `available` argument is a
  Dutch-auction decay window. Passing `0` prices a never-registered name at a
  ~100,000,000 USDC premium. The registrar itself passes `block.timestamp` for
  a name that was never registered, which decays the premium to zero. Anyone
  pricing off-chain without reading `_availablePeriod` will get a wild number
  and assume they cannot afford the name.
