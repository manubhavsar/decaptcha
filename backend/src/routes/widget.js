/**
 * The embeddable widget's API.
 *
 * This is the product surface: a site drops in one script tag and one div, and
 * gets a CAPTCHA that admits humans the usual way and accountable agents
 * without a challenge. The endpoints mirror reCAPTCHA's shape on purpose, so
 * adopting this is a swap rather than a rewrite.
 *
 *   POST /api/widget/probe      is this visitor already vouched for?
 *   GET  /api/widget/challenge  give me an image challenge
 *   POST /api/widget/solve      here is my answer
 *   POST /api/siteverify        (site backend) is this token good?
 */

import express from 'express';

import { issueChallenge, verifyChallenge } from '../lib/challenge.js';
import { resolveVouch } from '../lib/vouch.js';
import { issueToken, consumeToken, knownSite, tokenStats } from '../lib/tokens.js';
import { logEvent, vouchUseCount, recordVouchUse } from '../lib/state.js';

export const widgetRouter = express.Router();

function site(req, res) {
  const sitekey = String(req.body?.sitekey ?? req.query?.sitekey ?? '');
  const cfg = knownSite(sitekey);
  if (!cfg) {
    res.status(400).json({ error: 'unknown_sitekey', detail: `No site registered for "${sitekey}".` });
    return null;
  }
  return { sitekey, cfg };
}

/**
 * Called the moment the widget loads. If the visitor is carrying a valid vouch
 * they never see a challenge at all — which is the entire point. Otherwise the
 * widget falls back to the ordinary human path.
 */
widgetRouter.post('/widget/probe', async (req, res) => {
  const s = site(req, res);
  if (!s) return;

  const vouchName = req.body?.vouchName || req.get('X-Decaptcha-Vouch') || null;
  const agentAddress = req.body?.agentAddress || req.get('X-Decaptcha-Agent') || null;

  if (!vouchName) {
    return res.json({ outcome: 'challenge', reason: 'no_credential',
      detail: 'No vouch presented. Falling back to the human challenge.' });
  }

  const vouch = await resolveVouch(vouchName);
  const deny = (reason, detail) => {
    logEvent({ outcome: 'block', reason, detail, actor: `agent (${vouchName})`, vouchName });
    return res.json({ outcome: 'challenge', reason, detail, vouchName });
  };

  if (!vouch.found) {
    return deny('vouch_unknown',
      `${vouchName} does not resolve to a vouch. Treated as an anonymous bot.`);
  }
  if (!vouch.authorised) {
    return deny('vouch_unauthorised',
      `${vouchName} carries no valid authorisation signature from the human named on it.`);
  }
  if (vouch.revoked) {
    return deny('vouch_revoked', `${vouchName} was revoked by ${vouch.humanLabel}.`);
  }
  if (vouch.expired) {
    return deny('vouch_expired', `${vouchName} expired at ${vouch.expiresAt}.`);
  }
  if (vouch.agentAddress && agentAddress
      && vouch.agentAddress.toLowerCase() !== agentAddress.toLowerCase()) {
    return deny('vouch_wrong_agent', `${vouchName} was not minted for ${agentAddress}.`);
  }

  const used = vouchUseCount(vouchName);
  if (used >= vouch.scopeMaxClaims) {
    return deny('scope_exceeded',
      `${vouchName} is scoped to ${vouch.scopeMaxClaims} verification(s) and has used ${used}.`);
  }

  const n = recordVouchUse(vouchName);
  const { token, expiresIn } = issueToken({
    sitekey: s.sitekey, kind: 'agent', vouchName,
    actingFor: vouch.humanAddress,
    scope: { max: vouch.scopeMaxClaims, used: n, expiresAt: vouch.expiresAt },
  });

  logEvent({
    outcome: 'allow', reason: 'vouch_valid',
    detail: `Agent passed the widget without a challenge, acting for ${vouch.humanLabel}. Use ${n} of ${vouch.scopeMaxClaims}.`,
    actor: `agent (${vouchName})`, vouchName, actingFor: vouch.humanLabel,
  });

  res.json({
    outcome: 'allow', token, expiresIn,
    kind: 'agent',
    actingFor: vouch.humanLabel,
    actingForAddress: vouch.humanAddress,
    scope: { max: vouch.scopeMaxClaims, used: n },
    expiresAt: vouch.expiresAt,
    resolverUrl: vouch.resolverUrl,
    vouchName,
  });
});

widgetRouter.get('/widget/challenge', (req, res) => {
  const s = site(req, res);
  if (!s) return;
  res.json(issueChallenge());
});

widgetRouter.post('/widget/solve', (req, res) => {
  const s = site(req, res);
  if (!s) return;

  const verdict = verifyChallenge({
    challengeId: req.body?.challengeId,
    answer: req.body?.answer,
    behavior: req.body?.behavior,
  });

  if (!verdict.ok) {
    logEvent({ outcome: 'block', reason: verdict.reason, detail: verdict.detail, actor: 'visitor' });
    return res.status(400).json({ outcome: 'block', ...verdict });
  }

  const { token, expiresIn } = issueToken({ sitekey: s.sitekey, kind: 'human' });
  logEvent({
    outcome: 'allow', reason: 'human_verified',
    detail: 'Visitor solved the challenge. Human admitted.', actor: 'human',
  });
  res.json({ outcome: 'allow', token, expiresIn, kind: 'human' });
});

/**
 * Site backends call this, exactly as they would call reCAPTCHA's siteverify.
 * The two extra fields are the whole product: whether a human or an accountable
 * agent passed, and which human is on the hook.
 */
widgetRouter.post('/siteverify', (req, res) => {
  const secret = req.body?.secret ?? '';
  const token = req.body?.response ?? req.body?.token ?? '';
  res.json(consumeToken({ token, secret }));
});

widgetRouter.get('/widget/stats', (_req, res) => res.json(tokenStats()));
