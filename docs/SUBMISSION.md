# ETHGlobal submission answers

Copy-paste ready. Character counts checked.

---

## Emoji

🛂

Passport control: a gate that checks who vouched for you, rather than what you
are. Avoids the generic 🤖 and 🔐, and reads as a checkpoint at a glance.

---

## Category

**Security.**

The product is a bot-detection gate; what's being judged is access control —
who gets through, how much, and how it's taken away. Abuse prevention is also
the exact framing World's Selfie Check track uses.

*Second pick, if allowed:* infrastructure. Not AI — the agent angle is why the
problem exists, not the mechanism, and judges filtering the AI category are
looking for models and agents, where this would read as off-topic.

---

## Short description  *(90 / 100 characters)*

```
A CAPTCHA that lets real agents through, not just real humans. Vouched, scoped, revocable.
```

---

## Description

```
Every anti-bot gate on the internet asks the same question: are you a human?
That question has no good answer for an AI agent doing real work for a real
person, so legitimate agents get blocked alongside the scrapers. Cloudflare,
reCAPTCHA and Amazon's own AgentCore browser are all fighting this right now.

deCAPTCHA asks a different question: is a real, verified human accountable for
this request? If one is, the agent goes straight through — capped to exactly
what that human allowed, expiring on a deadline they set, and revocable by them
at any moment.

A human completes World's Selfie Check once. That mints a vouch: an ENSv2
subname on Sepolia with its own Permissioned Resolver, carrying a scope, an
expiry, and a reference to the credential. Their agent is handed that subname.

Four things happen at the gate, and all four run live:

1. An anonymous bot is blocked by an ordinary CAPTCHA, exactly as today.
2. The same script, carrying the vouch, is admitted instantly and logged as
   acting for that human. One extra header. No API key, no allowlist.
3. Its next claim beyond scope is refused — blocked like an unvouched bot. The
   cap is the number the human wrote on chain, not a policy in the gate.
4. The agent tries to raise its own scope and is refused by ENSv2's Enhanced
   Access Control, not by application logic. Then the human taps revoke, the
   transaction lands on Sepolia, and the agent's very next request is blocked.

The gate never caches. A cache of even a few seconds would mean revocation
didn't bind on the next request, and "revocable" would be a claim rather than a
demonstrated property.

The strongest part is what minting ends with: the issuer renounces its own root
roles on the vouch's resolver. So the final state isn't "only the human can
write" — it's that nobody but the human can, including us. Anyone can verify
that by reading the resolver on Sepolia.
```

---

## How it's made

```
Backend is Node and Express. The gate is one decision function that asks, in
order: is a human accountable for this, can you prove you're human right now,
otherwise blocked. Conventional gates only have the last two, which is exactly
why they can't tell a scalper script from an agent doing real work.

ENS — ENSv2 on Sepolia, and the primitive that makes this work is
PermissionedResolver scoping Enhanced Access Control resources to
keccak256(node, part): a name AND a record type. So write permission is granted
on one specific field of one specific vouch. The human holds ROLE_SET_TEXT on
the revocation record; the agent holds nothing anywhere. Its self-extension
attempt reverts with EACUnauthorizedAccountRoles naming the account and the
missing role. That refusal is the protocol's, not ours.

Each vouch gets its OWN resolver, cloned through VerifiableFactory, so its
records and permissions belong to it alone rather than sitting in a shared
table. Minting is three transactions: deploy-and-populate, register the
subname, then grant the human and renounce ourselves in one multicall.
Deploy-and-populate works because PermissionedResolver skips permission checks
while initializing, so records exist before anyone holds a role over them.

Expiry is two layers. The subname deliberately outlives its vouch by a week —
setting them equal looked tidy and was wrong, because the name stopped
resolving before the gate could read the record and say why.

World — Selfie Check via IDKit v4 with server-side RP signing; the key never
leaves the backend and the extension only ever gets a connector URI. Used as an
abuse-prevention signal, which is what World documents it for. We never claim
uniqueness and the gate doesn't need it: because the vouch is capped and
revocable, medium assurance is the right level rather than a compromise.

Three hacky bits worth mentioning. The CAPTCHA image is rasterised to PNG by
hand — bitmap font, sine warp, noise, zlib — because shipping it as SVG or JSON
would let a bot read the answer out of the payload and make the blocked beat
theatre. The Chrome extension attaches the vouch via a MAIN-world fetch patch,
so the demo site's own code is untouched and knows nothing about vouches, which
is how this would really deploy. And the credential reference published on
chain is a one-way digest of the World nullifier, never the nullifier itself —
the subname is public, and a raw nullifier there would let anyone link every
action that human's agents ever take.
```

---

## Demo link

**You still need one.** Options, best first:

1. A screen recording of `node scripts/demo.js` alongside the browser, with a
   Sepolia explorer tab open on the revoke transaction. Ninety seconds.
2. The repo, once public: https://github.com/manubhavsar/decaptcha

The revoke landing on Etherscan while the agent's next request turns red is the
single most convincing thing in this project. Get it on camera.
