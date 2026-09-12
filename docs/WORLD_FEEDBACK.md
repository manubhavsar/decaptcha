# Feedback for World — Selfie Check integration

Submitted for ETHGlobal ETHOnline 2026, Selfie Check track.
Project: **deCAPTCHA** — https://github.com/manubhavsar/decaptcha

## How to read this

Everything below is grounded in something I actually did. Where a claim comes
from reading source or types, I say which file or package version. Where I
could not test something, I say so rather than guessing — a feedback document
padded with invented experience is worse than a short honest one.

Verified against the `worldcoin/developer-docs` repository and
`@worldcoin/idkit-core@4.2.4` from npm, on 12–13 September 2026.

**Scope limit, stated up front:** at time of writing, Selfie Check (Beta) had
not been enabled for our app and sandbox tester access had not come through, so
**we never completed a live Selfie Check**. Sections 3 and 4 are therefore
about the *path to being able to test*, which is itself where our time went.
Section 4 is explicitly incomplete and marked as such.

---

## 1. Selfie Check documentation and integration flow

### What worked well

**The credential page is unusually clear about what the credential is not.**
`/world-id/credentials/11` states plainly that Selfie Check is medium
assurance, gives no one-person-one-account guarantee, and returns no numeric
Sybil score. That saved us from overclaiming. Our design leans on it as an
abuse-prevention signal with a scope-capped, revocable consequence, and we
could only make that argument confidently because the docs were direct about
the limits.

**Naming the three use cases (liveness, abuse resistance, continuity) is
genuinely useful.** It let us match our use to World's own framing rather than
inventing our own vocabulary.

**The version-pinning warning is prominent and correct.** "Pin SDKs to `^4.x`;
older v2/v3 samples across the web won't work with the v4 API redesign" appears
early. We hit exactly zero time lost to stale samples because of it. This is
the single highest-value sentence in the docs right now.

**`/world-id/SKILL` and the agent-visible tables are forward-thinking.** Pages
carry a `<Visibility for="agents">` markdown table mirroring the human-facing
hero component. For anyone integrating with an AI assistant in the loop, this
is a real quality-of-life difference and we noticed it immediately.

**Non-React integration is a first-class path.** `IDKitRequest` exposes
`connectorURI` and `pollUntilCompletion()`, so we drove the flow from a Chrome
extension popup with a server-rendered QR and never touched the React widget.
The docs lead with React, but the vanilla path is documented and complete.

### Friction

**Credential pages are addressed by numeric ID, and nothing redirects.**
Selfie Check lives at `/world-id/credentials/11`. We first tried
`/world-id/selfie-check` and `/world-id/credentials/selfie-check`; both 404 with
no redirect and no suggestion. Discovery by URL guess — which is how a lot of
people navigate docs — fails outright. A slug alias per credential would cost
nothing.

**`selfieCheckLegacy` is on World ID 3.0 while the surrounding docs describe
4.0 response shapes.** The credential page says so, but the integration page's
response examples are 4.0-shaped. A backend written straight from
`/world-id/idkit/integrate` will look for the wrong fields. We ended up writing
a nullifier extractor that reads both shapes defensively:

```js
const responses = result.responses ?? result.response ?? [];
const first = Array.isArray(responses) ? responses[0] : responses;
return first?.nullifier ?? first?.session_nullifier
    ?? result.nullifier ?? result.nullifier_hash ?? null;
```

We should not have needed to guess at that. A single "if you are using
`selfieCheckLegacy`, expect *this* response shape" block on the credential page
would remove the ambiguity.

**A concrete inconsistency worth checking: the `environment` enum.**
`@worldcoin/idkit-core@4.2.4` types `environment` as:

```ts
environment?: "production" | "staging" | "sandbox"
```

The sandbox guide instructs `environment: sandbox` and says to send the proof to
the **production** verify endpoint. But the OpenAPI spec behind
`/api-reference/developer-portal/verify` documents the request's `environment`
field as production/staging only. Since the guidance is to forward the IDKit
payload byte-for-byte with no remapping, a sandbox proof carries
`environment: "sandbox"` into an endpoint whose published schema does not list
that value. Either the schema is out of date or sandbox proofs need different
handling. We could not resolve which without live access, and this is exactly
the kind of mismatch that produces a confusing failure at the worst moment.

### Correcting our own earlier note

An earlier draft of these notes claimed the verify endpoint had no documented
error codes. That was wrong and we are flagging it rather than quietly deleting
it. `/api-reference/developer-portal/verify` documents request and response
shapes properly and names `app_not_migrated`, `all_verifications_failed` and
`verification_error`. Separately, `/world-id/idkit/error-codes` is a good,
complete table of bridge and SDK codes including `credential_unavailable`,
which is presumably what an app without the Selfie Check flag receives.

The remaining real gap is narrower: the verify endpoint's error codes are given
as *examples*, not an enumeration. For a payment-adjacent or access-granting
integration, an exhaustive list matters, because the correct behaviour on an
unrecognised failure code is not obvious.

---

## 2. Developer Portal — navigation, search, product discovery, debugging

**We cannot answer this section from experience and will not pretend
otherwise.** Our team member holds the Portal account; the integration work
described here was done against docs, the published SDK and the live verify
endpoint contract. Writing a critique of Portal navigation we did not perform
would be noise in a document whose value depends on being trustworthy.

Two things we *can* report, because they shaped the work:

**The three values an integrator needs are stated clearly and early.**
`app_id`, `rp_id` and a server-side `signing_key`, with an unambiguous warning
never to generate signatures client-side or expose the key. We built to that
from the first commit: our RP signing lives entirely in the backend and the
browser extension only ever receives a connector URI.

**RP signing works fully offline, which is excellent for testing.** We verified
that `signRequest({ signingKeyHex, action })` from
`@worldcoin/idkit-core/signing` produces a valid-looking signature with any
32-byte hex key, no network and no Portal account:

```
sig    132 chars (0x + 65 bytes)
nonce  66 chars (0x + 32 bytes)
ttl    300s default
```

That let us write and unit-test the entire signing path before credentials
existed. More SDKs should be testable this way. It is worth documenting
explicitly as a supported workflow, because we only discovered it by trying.

---

## 3. The two access gates — the biggest single piece of feedback

**This is where our time actually went, and it is the thing we would most want
changed.**

Testing Selfie Check requires two independent approvals, neither self-serve,
each documented on a different page, with no single page listing both:

1. **The Selfie Check (Beta) feature flag**, per app, requested from
   `developers@toolsforhumanity.com`. Documented in a `<Warning>` on
   `/world-id/credentials/11` and again on `/world-id/idkit/credentials`.
2. **Sandbox tester enrolment**, via the Portal, then TestFlight (iOS) or a
   private Google Play track (Android). Documented on
   `/world-id/sandbox/sandbox-access`.

The ordering trap is real and we walked into it: it is entirely possible to
work through sandbox enrolment first and only then discover the feature flag is
a second, unrelated request with its own queue. The sandbox testing page does
warn about the flag, but only if you reach that page before the access page.

**What would fix it:** a single "before you can test Selfie Check" checklist,
linked from the credential page, listing both approvals with expected
turnaround. Even "typically N business days" would let a team decide whether to
build against it at all. Right now both pages say "wait for approval" with no
stated timeline, which makes the risk unquantifiable — and for a hackathon,
unquantifiable means unplannable.

**A smaller point with real consequences.** The docs note that resubmitting a
rejected sandbox email does not create a new request, and you must contact
`sandbox.access@toolsforhumanity.org`. Combined with the requirement that the
email exactly match the Apple Account used for TestFlight, a single typo costs
a support round trip. That warning deserves to sit *above* the form, not in a
troubleshooting section below it.

**Observed confusion worth reporting.** Our own first instinct was to look for
the enrolment inside the TestFlight app, which only offers a redeem-code field.
The request is made on the Portal website and the TestFlight invite arrives by
email afterwards. The docs are correct, but the mental model "TestFlight build
→ open TestFlight" is strong enough that a one-line "you do this on the web,
not in TestFlight" would prevent it.

---

## 4. Sandbox — states, proof flows, test users, errors, edge cases

**Incomplete, and we want to be explicit about why:** access did not arrive
during the hackathon window, so we never ran a proof through the sandbox app.
We are not going to describe flows we did not see.

What we can offer is a documentation review plus the gaps we anticipated while
building against them.

**The Hot / Cold / Semi-cold coverage matrix is good.** Splitting by entry
surface and user state, with a row for what each exercises, is the clearest
part of the sandbox docs. Knowing in advance that the web path is
cross-device-by-QR and that the proof returns to the originating web session
shaped our architecture directly: we poll from the backend and render the QR
server-side, so nothing depends on the extension staying open.

**Known limitations are disclosed honestly**, including that iOS Semi-cold is
degraded and that invite-code handling differs by platform. Publishing your own
rough edges is the right call and it is genuinely rare.

**The gap we care most about: no documented way to exercise failure.** Every
described journey is a happy path. There is no documented way to force a spoof
detection, a declined liveness check, a mid-flow abandonment, or an expired
credential. Our gate has to behave correctly and legibly when a Selfie Check
*fails* — that is the entire security-relevant branch — and there is no way to
test it. `/world-id/idkit/error-codes` tells us which codes exist; sandbox does
not appear to let us provoke them.

If sandbox added a way to force specific outcomes for a test user, that would
be the single highest-value addition for anyone building an access-control
integration rather than a sign-up flow.

**Also undocumented:** whether the 90-day inactivity re-enrolment can be
simulated. Our vouches carry expiries, and we would have liked to test the
interaction between a vouch outliving its underlying credential. We designed
around it conservatively instead of verifying it.

---

## 5. Summary — what we would change, in priority order

1. **One page listing both access gates**, with expected turnaround. This cost
   us more than every other issue combined.
2. **A way to force failure outcomes in sandbox.** Happy paths alone cannot
   validate an integration whose job is refusing things.
3. **Resolve the `environment` enum mismatch** between the IDKit types, the
   sandbox guidance, and the verify endpoint's published schema.
4. **State the `selfieCheckLegacy` (World ID 3.0) response shape** on the
   credential page, since the surrounding docs show 4.0.
5. **Slug aliases for credential pages.** `/world-id/credentials/11` is not
   guessable.
6. **Document offline RP signing as a supported testing workflow.** It let us
   build the whole signing path before we had credentials, and we found it by
   accident.

## What we built with it

deCAPTCHA is a bot gate that blocks anonymous bots normally, but admits an AI
agent instantly when a human has passed Selfie Check and vouched for it. The
vouch is an ENSv2 subname on Sepolia carrying a scope, an expiry and a
revocation flag, and the human can revoke it at any moment.

Selfie Check is the abuse-prevention signal that makes the agent accountable to
a real person. We do not claim uniqueness, and the gate does not need it —
because the vouch is capped and revocable, a medium-assurance credential is the
right assurance level for the job rather than a compromise on a higher one.

The reference we publish on chain is a one-way digest of the nullifier, never
the nullifier itself, since the subname is public and a raw nullifier there
would let anyone link every action that human's agents ever take.

Integration code: [`backend/src/lib/world.js`](../backend/src/lib/world.js).
