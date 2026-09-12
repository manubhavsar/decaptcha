/**
 * The anonymous path: a conventional CAPTCHA-style challenge.
 *
 * This is deliberately an ordinary, boring bot gate — the kind every site
 * already runs. deCAPTCHA's argument is not that this gate is bad; it is that
 * this gate has no way to tell a scalper script from an agent doing real work
 * for a real person, so it blocks both. Everything in this file is the
 * "before" half of the demo.
 */

import crypto from 'node:crypto';
import { randomCode, renderCaptchaPng } from './captcha-image.js';

const TTL_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/** Minimum time a human plausibly needs to read a warped 6-character code. */
const MIN_SOLVE_MS = 900;
/** Distinct pointer positions a real cursor produces while reaching the input. */
const MIN_POINTER_SAMPLES = 8;

const challenges = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, c] of challenges) {
    if (c.expiresAt <= now) challenges.delete(id);
  }
}

export function issueChallenge() {
  sweep();
  const id = crypto.randomUUID();
  const code = randomCode(6);
  const png = renderCaptchaPng(code);

  challenges.set(id, {
    code,
    issuedAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    attempts: 0,
  });

  return {
    challengeId: id,
    // The answer exists only as pixels. A fetch-loop bot receives this and has
    // nothing to do with it short of running OCR.
    image: `data:image/png;base64,${png.toString('base64')}`,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    attemptsAllowed: MAX_ATTEMPTS,
  };
}

/**
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}}
 */
export function verifyChallenge({ challengeId, answer, behavior }) {
  sweep();

  if (!challengeId) {
    return { ok: false, reason: 'challenge_required', detail: 'No challenge presented.' };
  }

  const c = challenges.get(challengeId);
  if (!c) {
    return {
      ok: false,
      reason: 'challenge_expired',
      detail: 'Challenge unknown or expired. Request a fresh one.',
    };
  }

  c.attempts += 1;
  if (c.attempts > MAX_ATTEMPTS) {
    challenges.delete(challengeId);
    return {
      ok: false,
      reason: 'challenge_failed',
      detail: `Out of attempts (${MAX_ATTEMPTS}). Challenge burned.`,
    };
  }

  // Behavioural signals. A script that skips the browser entirely cannot
  // produce these at all, so this catches the naive replay before we even look
  // at the answer.
  const elapsed = Number(behavior?.elapsedMs ?? 0);
  const samples = Number(behavior?.pointerSamples ?? 0);

  if (!Number.isFinite(elapsed) || elapsed < MIN_SOLVE_MS) {
    return {
      ok: false,
      reason: 'challenge_failed',
      detail: `Solved in ${elapsed}ms — faster than a human can read the image.`,
    };
  }
  if (!Number.isFinite(samples) || samples < MIN_POINTER_SAMPLES) {
    return {
      ok: false,
      reason: 'challenge_failed',
      detail: `Only ${samples} pointer samples — no evidence of a real cursor.`,
    };
  }

  if (String(answer ?? '').trim().toUpperCase() !== c.code) {
    const left = MAX_ATTEMPTS - c.attempts;
    return {
      ok: false,
      reason: 'challenge_failed',
      detail: left > 0
        ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'Wrong code. Challenge burned.',
    };
  }

  challenges.delete(challengeId);
  return { ok: true };
}

export function challengeStats() {
  sweep();
  return { open: challenges.size };
}
