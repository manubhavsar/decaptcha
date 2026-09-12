# World ID integration notes

Working notes gathered while integrating Selfie Check (Beta). Raw material for
the required feedback document (build step 8) — observations are recorded here
as they happen, while the friction is still fresh, rather than reconstructed at
the end.

Verified against the live docs source (`worldcoin/developer-docs`, read at
commit-time on 2026-09-12) and against `@worldcoin/idkit-core@4.2.4` as
published on npm, not from memory.

---

## What Selfie Check actually is

| Property | Value |
| --- | --- |
| Credential ID | `11` |
| Status | Beta |
| Issuer | Tools for Humanity (verified issuer) |
| Assurance | Medium — device camera liveness + facial similarity |
| Validity | 90 days of inactivity, then the camera flow repeats |
| Protocol | World ID 3.0 (4.0 support not yet available for this preset) |
| SDK preset | `selfieCheckLegacy({ signal })` |

Docs state its purposes as **liveness detection, abuse resistance, and
continuity**, and are explicit that it is *not* a one-person-one-account
guarantee and returns no numeric Sybil score.

**Why this matters for deCAPTCHA:** our use is squarely *abuse resistance* — a
low-friction human signal that makes an agent's access accountable. We are not
claiming uniqueness, and the gate does not need it. The vouch caps what the
agent can do, so a medium-assurance credential is the correct assurance level
for the job rather than a compromise.

## Two separate access gates (both need lead time)

This is the single biggest schedule risk on this track, and neither gate is
something an integrator can unblock themselves.

1. **Selfie Check feature flag** — "Selfie Check (Beta) is access-gated. To use
   it, request access so the feature flag can be enabled for your app."
   Requested from `developers@toolsforhumanity.com`, or via a World point of
   contact. Applies per app.
2. **Sandbox app tester access** — the sandbox World ID app is not publicly
   listed. iOS goes through TestFlight enrollment (submit an Apple Account email
   in the Developer Portal under *World ID Sandbox*, then wait for approval);
   Android goes through a private Google Play testing track keyed to a specific
   Google account. Both say "wait for approval".

Note the ordering trap: sandbox tester access alone is not enough to test Selfie
Check. You need the feature flag *as well*, and the docs surface the two
requirements on different pages.

## Integration shape

Credentials needed from the Developer Portal: `app_id`, `rp_id`, and a
`signing_key` that must stay server-side.

Flow:

1. Backend signs the request with `signRequest({ signingKeyHex, action })` from
   `@worldcoin/idkit-core/signing`, producing `sig`, `nonce`, `created_at`,
   `expires_at`.
2. `IDKit.request({ app_id, action, rp_context, environment })
   .preset(selfieCheckLegacy({ signal }))` returns an `IDKitRequest` exposing
   `connectorURI` (render as a QR), `requestId`, `pollOnce()` and
   `pollUntilCompletion()`.
3. The completed result is forwarded **byte-for-byte** to
   `POST https://developer.world.org/api/v4/verify/{rp_id}` — no field remapping.
4. The returned nullifier is stored to prevent replay. Docs recommend
   `NUMERIC(78,0)` with `UNIQUE (action, nullifier)`, converting hex to decimal.

Environment is a first-class option: `"production" | "staging" | "sandbox"`.
Sandbox proofs still verify against the **production** verify endpoint.

## Observations for the feedback document

Recorded as encountered. Neutral where the docs were good.

- **Good:** the docs repo ships an agent-oriented page (`/world-id/SKILL`) and
  per-page agent-visible tables. Pinning guidance ("pin to `^4.x`; v2/v3 samples
  across the web won't work") is stated up front and saved real time.
- **Good:** `IDKitRequest` exposes `connectorURI` + `pollUntilCompletion()`, so a
  non-React surface is a first-class path, not a workaround. Our client is a
  Chrome extension popup; we never needed the React widget.
- **Friction:** credential pages are addressed by numeric ID
  (`/world-id/credentials/11`) rather than a readable slug. Guessing
  `/world-id/credentials/selfie-check` or `/world-id/selfie-check` returns 404,
  and neither redirects. Discovery by URL guess fails; you must go through the
  index.
- **Friction:** the two access gates are documented on separate pages with no
  single "here is everything you need before you can test Selfie Check"
  checklist. It is possible to complete sandbox enrollment and only then learn
  the feature flag is a second, independent request.
- **Friction:** `selfieCheckLegacy` is the only preset still on World ID 3.0
  while the surrounding docs describe 4.0 response shapes. A backend written
  from the 4.0 examples will parse a differently-shaped response.
- **CORRECTED.** An earlier version of this note claimed the verify endpoint
  had no documented error codes. That was wrong. `/api-reference/developer-portal/verify`
  documents request and response shapes and names three codes, and
  `/world-id/idkit/error-codes` is a complete table of bridge/SDK codes. The
  real gap is narrower: the verify endpoint's codes are given as *examples*,
  not an enumeration.
- **Inconsistency:** `@worldcoin/idkit-core@4.2.4` types `environment` as
  `"production" | "staging" | "sandbox"`, and the sandbox guide says to use
  `sandbox` and post to the production verify endpoint. But that endpoint's
  OpenAPI schema documents `environment` as production/staging only. Since the
  payload is forwarded byte-for-byte, a sandbox proof carries a value the
  published schema does not list.
- **Gap:** no documented way to exercise a Selfie Check *failure* (spoof
  detected, liveness declined) in Sandbox. Only the happy path has a described
  journey, which makes error-state UI hard to test honestly.
