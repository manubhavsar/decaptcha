import './lib/env-init.js'; // must be first: loads .env before other modules evaluate

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { issueChallenge, challengeStats } from './lib/challenge.js';
import { handleClaim } from './lib/gate.js';
import { vouchBackendStatus, resolveVouch, permissionReport } from './lib/vouch.js';
import { mintVouch, revokeVouch, attemptSelfExtend, vouchWriteStatus } from './lib/ens-write.js';
import { widgetRouter } from './routes/widget.js';
import {
  DROP, remaining, claimCount, allClaims,
  recentLog, onEvent, resetDemo, logEvent,
} from './lib/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: '64kb' }));

// The Chrome extension's content script talks to this origin from the demo page,
// and the bot scripts talk to it from Node. Open CORS is fine for a local demo.
app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Decaptcha-Vouch');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

// The embeddable widget: the product surface any site can drop in.
app.use('/api', widgetRouter);

/* ------------------------------- drop state ------------------------------ */

app.get('/api/drop', (_req, res) => {
  res.json({
    drop: DROP,
    remaining: remaining(),
    claimed: claimCount(),
    claims: allClaims().slice(-10),
    vouchBackend: vouchBackendStatus(),
  });
});

/* -------------------------------- challenge ------------------------------ */

app.get('/api/challenge', (_req, res) => {
  res.json(issueChallenge());
});

/* ---------------------------------- claim -------------------------------- */

app.post('/api/claim', async (req, res) => {
  const body = req.body ?? {};

  // A vouch may arrive in the body (bot scripts) or as a header (the extension's
  // content script injects it, so the page itself never has to know about it).
  const vouchName = body.vouchName || req.get('X-Decaptcha-Vouch') || null;

  const result = await handleClaim({
    vouchName,
    agentAddress: body.agentAddress ?? null,
    challengeId: body.challengeId ?? null,
    answer: body.answer ?? null,
    behavior: body.behavior ?? null,
    humanId: body.humanId ?? null,
    actorLabel: body.actorLabel ?? null,
    userAgent: req.get('user-agent') ?? '',
  });

  const status = result.outcome === 'allow' ? 200 : result.outcome === 'challenge' ? 401 : 403;
  res.status(status).json(result);
});


/* ------------------------------- vouches --------------------------------- */
/* Read endpoints resolve live from ENSv2 on Sepolia. Write endpoints send real
   transactions. Nothing here is mocked; see lib/ens.js and lib/ens-write.js. */

app.get('/api/vouch/status', (_req, res) => {
  res.json({ ...vouchBackendStatus(), write: vouchWriteStatus() });
});

app.get('/api/vouch/:name', async (req, res) => {
  const vouch = await resolveVouch(req.params.name);
  // The permission table is the evidence for the accountability beat, so it is
  // read from chain alongside the record rather than asserted by the server.
  const permissions = vouch.found ? await permissionReport(vouch).catch(() => null) : null;
  res.json({ ...vouch, permissions });
});

app.post('/api/vouch/mint', async (req, res) => {
  try {
    const out = await mintVouch({
      scopeMaxClaims: Math.max(1, Math.min(10, Number(req.body?.scopeMaxClaims) || 1)),
      ttlHours: Math.max(1, Math.min(168, Number(req.body?.ttlHours) || 24)),
      // Minting takes about 45s across three Sepolia transactions. Pushing each
      // step onto the live log means the popup and the demo page both show real
      // progress from the real source, instead of a spinner that guesses.
      onStep: ({ step, of, detail }) => logEvent({
        outcome: 'info',
        reason: 'vouch_minting',
        detail: `[${step}/${of}] ${detail}`,
        actor: 'human',
      }),
    });
    logEvent({
      outcome: 'info',
      reason: 'vouch_minted',
      detail: `${out.vouchName} minted with its own resolver. Scope ${out.scopeMaxClaims}, expires ${out.expiresAt}.`,
      actor: 'human',
      vouchName: out.vouchName,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'mint_failed', detail: e.shortMessage ?? e.message });
  }
});

app.post('/api/vouch/revoke', async (req, res) => {
  try {
    const vouchName = String(req.body?.vouchName ?? '');
    const vouch = await resolveVouch(vouchName);
    if (!vouch.found) return res.status(404).json({ error: 'unknown_vouch' });

    const out = await revokeVouch({ vouchName, resolverAddress: vouch.resolverAddress });
    logEvent({
      outcome: 'info',
      reason: 'vouch_revoked_onchain',
      detail: `Human revoked ${vouchName} on Sepolia. Next request from this agent will be refused.`,
      actor: 'human',
      vouchName,
      txUrl: out.txUrl,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'revoke_failed', detail: e.shortMessage ?? e.message });
  }
});

app.post('/api/vouch/self-extend', async (req, res) => {
  try {
    const vouchName = String(req.body?.vouchName ?? '');
    const vouch = await resolveVouch(vouchName);
    if (!vouch.found) return res.status(404).json({ error: 'unknown_vouch' });

    const out = await attemptSelfExtend({ vouchName, resolverAddress: vouch.resolverAddress });
    logEvent({
      outcome: out.denied ? 'block' : 'allow',
      reason: out.denied ? 'self_extend_denied' : 'self_extend_allowed',
      detail: out.detail,
      actor: `agent (${vouchName})`,
      vouchName,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'self_extend_failed', detail: e.shortMessage ?? e.message });
  }
});

/* ------------------------------- live gate log --------------------------- */

app.get('/api/log', (_req, res) => {
  res.json({ events: recentLog() });
});

// Server-sent events so the demo page and the extension badge can react to gate
// decisions the instant they happen — including ones triggered by a bot script
// running in another terminal.
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', remaining: remaining() })}\n\n`);

  const off = onEvent((entry) => {
    res.write(`data: ${JSON.stringify({ type: 'gate', entry, remaining: remaining() })}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => { off(); clearInterval(ping); });
});

/* --------------------------------- demo ops ------------------------------ */

app.post('/api/demo/reset', (_req, res) => {
  resetDemo();
  res.json({ ok: true, remaining: remaining() });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, challenges: challengeStats(), vouchBackend: vouchBackendStatus() });
});

/* --------------------------------- static -------------------------------- */

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  logEvent({
    outcome: 'info',
    reason: 'boot',
    detail: `Gate online. ${DROP.total} passes available. Vouch backend: ${vouchBackendStatus().source}.`,
    actor: 'gate',
  });
  console.log(`\n  deCAPTCHA gate  ->  http://localhost:${PORT}\n`);
});
