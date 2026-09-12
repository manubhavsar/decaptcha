/**
 * Vouch resolution.
 *
 * ==== STEP 1 PLACEHOLDER — NOT YET WIRED TO ENS ====
 *
 * In the finished build this module resolves a vouch subname (e.g.
 * agent123.decaptcha.eth) live against ENSv2 on Sepolia and reads its scope,
 * expiry and revocation flag from that subname's own Permissioned Resolver.
 * Nothing about a vouch is stored in this process — that is the point. The
 * human's revoke is an on-chain write, and the gate must see it on the very
 * next request without any server-side cache to invalidate.
 *
 * Right now it always reports "no vouch found", because step 1 of the build is
 * the pre-blockchain baseline: prove that a raw bot script gets blocked by an
 * ordinary CAPTCHA gate. Presenting a vouch name at this stage correctly gets
 * you treated as an anonymous bot. There are no hard-coded demo vouches here
 * and there will not be any — ENS's track rules require every resolution and
 * permission check to run live against Sepolia.
 *
 * Contract this must satisfy once wired (step 3):
 *
 *   resolveVouch(name) -> {
 *     found:          boolean,
 *     humanLabel:     string,   // display name for the accountable human
 *     humanCredential:string,   // reference to the World Selfie Check credential
 *     scopeMaxClaims: number,   // how many claims the human authorised
 *     expiresAt:      string,   // ISO8601
 *     expired:        boolean,
 *     revoked:        boolean,
 *     source:         string,   // 'ensv2-sepolia' once live
 *   }
 */

export async function resolveVouch(name) {
  return {
    found: false,
    name,
    source: 'not-implemented',
    note: 'ENSv2 resolution lands in build step 3.',
  };
}

export function vouchBackendStatus() {
  return {
    wired: false,
    source: 'not-implemented',
    note: 'Step 1 baseline: CAPTCHA gate only, no chain calls.',
  };
}
