/**
 * The gate: one decision function every claim request passes through.
 *
 * Order matters, and it is the whole argument of the project:
 *
 *   1. Is a verified human accountable for this request?   -> allow, on the record
 *   2. If not, can you prove you are a human right now?     -> CAPTCHA
 *   3. Otherwise                                            -> blocked
 *
 * Conventional bot gates only have steps 2 and 3, so an agent doing real work
 * for a real person is indistinguishable from a scalper script. Step 1 is the
 * addition — and critically it is not a bypass, because the vouch it checks
 * carries a scope, an expiry, and a revocation switch that only the human holds.
 *
 * Step 1 is not evaluated here in app logic beyond reading the answer: the
 * scope, expiry and revocation state are read live from ENSv2 on Sepolia by
 * lib/vouch.js. See README "Where ENS actually runs".
 */

import { verifyChallenge } from './challenge.js';
import { DROP, remaining, claimsBy, recordClaim, logEvent } from './state.js';
import { resolveVouch } from './vouch.js';

export const Outcome = {
  ALLOW: 'allow',
  CHALLENGE: 'challenge',
  BLOCK: 'block',
};

function block(reason, detail, extra = {}) {
  return { outcome: Outcome.BLOCK, reason, detail, ...extra };
}

function allow(detail, extra = {}) {
  return { outcome: Outcome.ALLOW, detail, ...extra };
}

/**
 * @param {object} req
 * @param {string|null} req.vouchName    ENS vouch subname presented as a credential, if any
 * @param {string|null} req.agentAddress The address the presenting agent controls
 * @param {string|null} req.challengeId
 * @param {string|null} req.answer
 * @param {object|null} req.behavior     { elapsedMs, pointerSamples }
 * @param {string}      req.userAgent
 */
export async function evaluateClaim(req) {
  if (remaining() <= 0) {
    return block('sold_out', `All ${DROP.total} passes are gone.`);
  }

  /* ---- 1. Vouched-agent path ------------------------------------------- */

  if (req.vouchName) {
    const vouch = await resolveVouch(req.vouchName);

    if (!vouch.found) {
      return block(
        'vouch_unknown',
        `${req.vouchName} does not resolve to a vouch. Treated as an anonymous bot.`,
        { vouchName: req.vouchName },
      );
    }
    if (vouch.revoked) {
      return block(
        'vouch_revoked',
        `${req.vouchName} was revoked by ${vouch.humanLabel}. Access ended.`,
        { vouchName: req.vouchName, vouch },
      );
    }
    if (vouch.expired) {
      return block(
        'vouch_expired',
        `${req.vouchName} expired at ${vouch.expiresAt}.`,
        { vouchName: req.vouchName, vouch },
      );
    }

    // Non-transferable. The vouch names the agent it was minted for, so handing
    // the subname to a different agent does not hand over the access.
    if (vouch.agentAddress && req.agentAddress
        && vouch.agentAddress.toLowerCase() !== req.agentAddress.toLowerCase()) {
      return block(
        'vouch_wrong_agent',
        `${req.vouchName} was minted for ${vouch.agentAddress}, not ${req.agentAddress}. A vouch is not transferable.`,
        { vouchName: req.vouchName, vouch },
      );
    }

    // Scope enforcement. This is the line that separates "accountable access"
    // from "a permanent skeleton key": the human said how much, and the gate
    // holds the agent to exactly that much.
    const used = claimsBy(req.vouchName).length;
    if (used >= vouch.scopeMaxClaims) {
      return block(
        'scope_exceeded',
        `${req.vouchName} is scoped to ${vouch.scopeMaxClaims} claim(s) and has used ${used}. Blocked like any unvouched bot.`,
        { vouchName: req.vouchName, vouch, used },
      );
    }

    return allow(
      `Vouched agent admitted, acting for ${vouch.humanLabel}. Claim ${used + 1} of ${vouch.scopeMaxClaims} allowed.`,
      { vouchName: req.vouchName, vouch, used },
    );
  }

  /* ---- 2. Anonymous path: prove you are human right now ----------------- */

  if (!req.challengeId) {
    return {
      outcome: Outcome.CHALLENGE,
      reason: 'challenge_required',
      detail: 'No vouch presented. Solve the challenge to continue.',
    };
  }

  const verdict = verifyChallenge({
    challengeId: req.challengeId,
    answer: req.answer,
    behavior: req.behavior,
  });

  if (!verdict.ok) {
    return block(verdict.reason, verdict.detail);
  }

  return allow('Challenge solved. Human admitted.', { human: true });
}

/**
 * Runs the gate, records the outcome in the ledger and the live log, and
 * returns a response body. Every path through the gate logs, so the demo page
 * can show the reasoning rather than just the verdict.
 */
export async function handleClaim(req) {
  const decision = await evaluateClaim(req);

  if (decision.outcome !== Outcome.ALLOW) {
    logEvent({
      outcome: decision.outcome,
      reason: decision.reason,
      detail: decision.detail,
      actor: req.actorLabel ?? (req.vouchName ? `agent (${req.vouchName})` : 'anonymous'),
      vouchName: req.vouchName ?? null,
    });
    return { ...decision, remaining: remaining() };
  }

  const actorId = req.vouchName ?? req.humanId ?? 'anonymous-human';
  const actorKind = req.vouchName ? 'agent' : 'human';

  const claim = recordClaim({
    actorId,
    actorKind,
    actingFor: decision.vouch?.humanLabel ?? null,
    label: DROP.name,
  });

  logEvent({
    outcome: Outcome.ALLOW,
    reason: req.vouchName ? 'vouch_valid' : 'human_verified',
    detail: decision.detail,
    actor: req.actorLabel ?? (req.vouchName ? `agent (${req.vouchName})` : 'human'),
    vouchName: req.vouchName ?? null,
    actingFor: decision.vouch?.humanLabel ?? null,
    serial: claim.serial,
  });

  return {
    ...decision,
    claim: { serial: claim.serial, label: claim.label, at: claim.at },
    remaining: remaining(),
  };
}
