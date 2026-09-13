/**
 * How a human authorises an agent, with no identity provider in the loop.
 *
 * The human signs a plain-language statement naming the agent, the scope and
 * the expiry. That signature is published on the vouch's own resolver, which
 * makes the vouch **self-verifying**: anyone can read the record off Sepolia,
 * recover the signer, and confirm the human whose address is on the record
 * really did consent to those exact terms. No server is trusted, and nothing
 * has to be taken on our word.
 *
 * This is deliberately separate from proof of personhood. It answers "did this
 * account authorise this agent, for these terms?" — not "is this account a
 * unique human?" Those are different questions, and conflating them is how
 * identity systems overclaim. A personhood credential can be layered on top by
 * binding it to the same address; the vouch mechanism does not depend on one.
 */

import { recoverMessageAddress } from 'viem';

/**
 * The exact bytes the human signs. Deliberately human-readable, because a
 * signature over an opaque hash is a signature over something the signer could
 * not have read.
 */
export function authorisationTerms({ vouchName, agentAddress, scopeMaxClaims, expiresAt }) {
  return [
    'deCAPTCHA vouch authorisation',
    '',
    `I authorise the agent at ${agentAddress}`,
    `to act for me under the name ${vouchName},`,
    `for at most ${scopeMaxClaims} verification${scopeMaxClaims === 1 ? '' : 's'},`,
    `until ${new Date(expiresAt * 1000).toISOString()}.`,
    '',
    'I can revoke this at any time by writing to this vouch on ENSv2.',
  ].join('\n');
}

/** Signs the terms as the human. */
export async function signAuthorisation(walletClient, terms) {
  return walletClient.signMessage({ message: terms });
}

/**
 * Recovers the signer and checks it matches the human named on the record.
 *
 * @returns {{valid: boolean, signer: string|null, reason?: string}}
 */
export async function verifyAuthorisation({ terms, signature, expectedSigner }) {
  if (!signature) return { valid: false, signer: null, reason: 'no_signature' };
  if (!expectedSigner) return { valid: false, signer: null, reason: 'no_human_on_record' };

  let signer;
  try {
    signer = await recoverMessageAddress({ message: terms, signature });
  } catch (e) {
    return { valid: false, signer: null, reason: `unrecoverable: ${e.shortMessage ?? e.message}` };
  }

  const ok = signer.toLowerCase() === expectedSigner.toLowerCase();
  return {
    valid: ok,
    signer,
    reason: ok ? undefined : 'signer_mismatch',
  };
}
