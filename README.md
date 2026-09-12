# deCAPTCHA

**A CAPTCHA that lets real agents through, not just real humans.**

Every anti-bot gate on the internet asks the same question: *are you a human?*
That question has no good answer for an AI agent doing real work for a real
person, so those agents get blocked alongside the scrapers.

deCAPTCHA asks a different question: **is a real, verified human accountable
for this request?** If one is, the agent goes straight through — capped to
exactly what that human allowed, expiring on a deadline they set, and revocable
by them at any moment.

Built for ETHGlobal ETHOnline 2026.
**World — Selfie Check** (primary) · **ENS — Best Use of ENSv2** (secondary)

---

## The four beats

```bash
npm run dev                            # terminal 1: the gate
node scripts/mint-vouch.js --scope 2   # mint a vouch on Sepolia
node scripts/demo.js                   # run the whole argument
```

1. **An anonymous bot is blocked.** Ordinary CAPTCHA, ordinary refusal.
2. **The same script, carrying a vouch, is admitted instantly.** One extra
   header naming an ENS subname. No API key and no allowlist.
3. **Its next claim is capped** with `scope_exceeded` — blocked exactly like an
   unvouched bot. The cap is the number the human wrote on chain.
4. **Two accountability beats.** The agent's attempt to raise its own scope is
   refused by ENSv2's own permission check, and the human's revoke blocks the
   agent's very next request.

`bots/raw-bot.js` and `bots/vouched-agent.js` are the same script. The only
difference is one header.

---

## Where ENS actually runs

Nothing about a vouch is stored in this codebase. Every value is read from
ENSv2 on Sepolia on every request.

| What | Where |
| --- | --- |
| **Live resolution** — find the resolver, read the records | [`backend/src/lib/ens.js`](backend/src/lib/ens.js) → `readVouch()` |
| **Permission checks** — who may write which record | [`backend/src/lib/ens.js`](backend/src/lib/ens.js) → `canWriteRecords()`, `vouchResource()` |
| **Minting** — deploy the vouch's own resolver, grant, renounce | [`backend/src/lib/ens-write.js`](backend/src/lib/ens-write.js) → `mintVouch()` |
| **Revocation** — the human's on-chain write | [`backend/src/lib/ens-write.js`](backend/src/lib/ens-write.js) → `revokeVouch()` |
| **The denial** — the agent's refused write | [`backend/src/lib/ens-write.js`](backend/src/lib/ens-write.js) → `attemptSelfExtend()` |
| **Where the gate consults it** | [`backend/src/lib/gate.js`](backend/src/lib/gate.js) → `evaluateClaim()` |
| **Verified deployment addresses** | [`backend/src/lib/ens-config.js`](backend/src/lib/ens-config.js) |

**There is no cache, deliberately.** A cache of even a few seconds would mean
the human's revoke did not bind on the agent's next request, and "revocable"
would be a claim rather than a demonstrated property. A full read including the
permission table takes about 450ms.

**There are no hard-coded vouch values.** `scripts/preflight.js` re-verifies
every contract address against Sepolia with `eth_getCode` on every run.

### Live on Sepolia

| | |
| --- | --- |
| Parent name | `decaptcha.eth` |
| Child registry | [`0xCd55B677…c0ef`](https://sepolia.etherscan.io/address/0xCd55B677A38A89804c84677EaFB789eCd876c0ef) |
| Registration | [`0xaa1cbcf5…6b4d`](https://sepolia.etherscan.io/tx/0xaa1cbcf5a2ed0ef1603bcb2188748d7aac3817b4086532abdf664877d4456b4d) |

### The three subname properties, honestly

- **Expiring** — two layers. `decaptcha.expiry` bounds the vouch and the
  subname's registry expiry bounds the name. The gate rejects on either.
- **Revocable** — the human writes `decaptcha.revoked` to the vouch's own
  resolver, with their own key. Watchable on Etherscan as it lands.
- **Non-transferable** — the vouch names the agent it was minted for. Handing
  the subname to a different agent does not hand over the access.

The track's bonus — *agents as namespaces, each with their own identity and
permissions* — is the literal architecture: one subname per agent, one resolver
per subname, one permission set per record.

### Why the agent provably cannot write to its own credential

`PermissionedResolver` scopes Enhanced Access Control resources to
`keccak256(node, part)` — a name **and** a record type. So write permission is
granted on one specific field of one specific vouch.

The agent's attempt reverts with ENS's own error, naming the account and the
role it lacks:

```
EACUnauthorizedAccountRoles(
  role     ROLE_SET_TEXT,
  account  0x58B84C789BdCD74c6D339B5f7745384c0a0D82ee   <- the agent
)
```

**Minting ends with the issuer renouncing its own root roles.** So the final
state is not "only the human can write" but *nobody* but the human can —
including us. Anyone can verify that by reading the resolver.

| Account | scope | expiry | revoked |
| --- | --- | --- | --- |
| human | can write | can write | can write |
| agent | no access | no access | no access |
| issuer | no access | no access | no access |

---

## Where World ID runs

[`backend/src/lib/world.js`](backend/src/lib/world.js) — RP request signing,
`selfieCheckLegacy` request creation, polling, portal verification, and
nullifier replay protection.

Selfie Check is used as an **abuse-prevention signal**, which is what World
documents it for. The claim we make on a passed check is narrow and bounded: a
live human took responsibility for this agent, for this many actions, until this
expiry, and can revoke it. We never claim the human is unique, and the gate
never needs that. Because the vouch is scope-capped and revocable, a
medium-assurance credential is the right assurance level for the job rather
than a compromise on a higher one.

**The reference published on chain is a one-way digest of the World nullifier,
never the nullifier itself.** The subname is public on Sepolia, and a raw
nullifier there would let anyone link every action that human's agents ever
take. A test asserts the raw value cannot appear in the record.

**Status: blocked on access.** Selfie Check (Beta) needs a per-app feature flag
and sandbox tester enrolment — two separate approvals, neither self-serve. The
integration is written and unit-tested; it needs three environment variables.
See [`docs/WORLD_INTEGRATION_NOTES.md`](docs/WORLD_INTEGRATION_NOTES.md).

---

## Running it

```bash
npm install
cp .env.example .env
node scripts/preflight.js --new-key     # burner wallet, Sepolia only
# fund that address from a faucet, then:
node scripts/preflight.js               # verifies RPC, gas, all 12 contracts
node scripts/register-parent.js         # one-time: register the parent name
npm run dev                             # http://localhost:8787
```

Then `node scripts/mint-vouch.js --scope 2` and `node scripts/demo.js`.

Everything runs on Sepolia. Gas comes from a faucet and name registration is
priced in a mock token whose `mint` is public, so **nothing costs real money**.
Use a throwaway key regardless.

### The extension

`extension/` is an unpacked MV3 extension. Load it at `chrome://extensions`
with developer mode on.

- **popup** — Selfie Check, scope selection, the live permission table, revoke
- **background** — holds the credential; can read the vouch but never write it
- **content** — a MAIN-world `fetch` patch attaches the vouch to claim requests,
  and a badge follows the gate's real verdicts over SSE

The demo page's own code knows nothing about vouches, on purpose. A real site
wouldn't. The agent side presents the credential from outside.

---

## Layout

```
backend/src/lib/   gate.js · challenge.js · captcha-image.js
                   ens.js · ens-write.js · ens-config.js · vouch.js
                   world.js · actors.js · state.js
backend/public/    the demo drop page
bots/              raw-bot.js · vouched-agent.js  (same script, one header apart)
extension/         MV3 popup, background, content scripts
scripts/           preflight · register-parent · mint-vouch · demo
docs/              build log · ENS architecture · World integration notes
test/              node --test test/*.test.js
```

The CAPTCHA image is rasterised to PNG by hand in `captcha-image.js`, with no
native dependency. Shipping it as SVG or JSON would let a bot read the answer
out of the payload, which would make the blocked beat theatre.
