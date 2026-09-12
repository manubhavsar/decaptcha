#!/usr/bin/env node
/**
 * raw-bot — an anonymous scraper hitting the drop with no human behind it.
 *
 * This is the "before" beat of the demo, and it is also the honesty check on
 * the whole project: if this script could get through, the gate would be
 * decorative and letting vouched agents past would prove nothing.
 *
 * It tries four things a real scalper script would actually try, in order of
 * increasing effort, and reports what the gate said to each.
 *
 *   node bots/raw-bot.js
 */

const BASE = process.env.GATE ?? 'http://localhost:8787';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'user-agent': 'raw-bot/1.0' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'user-agent': 'raw-bot/1.0' } });
  return { status: r.status, body: await r.json() };
}

const results = [];

function report(attempt, res) {
  const allowed = res.body.outcome === 'allow';
  const tag = allowed ? C.green('ALLOWED') : C.red('BLOCKED');
  console.log(`  ${tag}  ${C.dim(res.body.reason ?? '—')}`);
  console.log(`          ${res.body.detail ?? ''}\n`);
  results.push({ attempt, allowed, reason: res.body.reason });
}

async function main() {
  console.log(`\n${C.bold('raw-bot')} ${C.dim('— anonymous scraper, no human, no credential')}`);
  console.log(C.dim(`  target: ${BASE}\n`));

  const drop = await get('/api/drop');
  console.log(`  target drop: ${C.bold(drop.body.drop.name)} — ${drop.body.remaining} left\n`);

  /* 1. The lazy attempt: just POST the claim. */
  console.log(C.bold('  [1] POST /api/claim with nothing attached'));
  report(1, await post('/api/claim', { actorLabel: 'raw-bot (anonymous)' }));

  /* 2. Ask for the challenge, then answer it. The image is a PNG; this script
        has no OCR, so the best it can do is guess. */
  console.log(C.bold('  [2] Fetch the challenge and guess the code'));
  const ch = await get('/api/challenge');
  const bytes = Math.round((ch.body.image.length * 3) / 4 / 1024);
  console.log(C.dim(`      got a ${bytes}KB PNG. No text in the payload — nothing to parse.`));
  report(2, await post('/api/claim', {
    actorLabel: 'raw-bot (guessing)',
    challengeId: ch.body.challengeId,
    answer: 'ABC123',
  }));

  /* 3. Forge the behavioural signals and brute-force. A determined script does
        exactly this, so the gate has to survive it. */
  console.log(C.bold('  [3] Forge human behaviour signals, then brute-force the code'));
  const ch2 = await get('/api/challenge');
  for (let i = 0; i < 4; i += 1) {
    const guess = Array.from({ length: 6 }, () =>
      'ABCDEFGHJKLMNPQRTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
    const res = await post('/api/claim', {
      actorLabel: 'raw-bot (forging behaviour)',
      challengeId: ch2.body.challengeId,
      answer: guess,
      behavior: { elapsedMs: 3200, pointerSamples: 41 },
    });
    console.log(C.dim(`      guess ${i + 1}: ${guess}  ->  ${res.body.reason}`));
    if (res.body.outcome === 'allow') { report(3, res); break; }
    if (i === 3) report(3, res);
  }

  /* 4. Invent a vouch name. Naming yourself after a credential is not holding
        one — the gate resolves it, finds nothing, and treats you as anonymous. */
  console.log(C.bold('  [4] Present a made-up vouch credential'));
  report(4, await post('/api/claim', {
    actorLabel: 'raw-bot (fake vouch)',
    vouchName: 'totally-legit-agent.decaptcha.eth',
  }));

  /* ------------------------------ verdict ------------------------------- */

  const got = results.filter((r) => r.allowed).length;
  const after = await get('/api/drop');

  console.log(C.bold('  ─── result ───'));
  console.log(`  attempts: ${results.length}   claims obtained: ${got === 0 ? C.green('0') : C.red(String(got))}`);
  console.log(`  inventory: ${after.body.remaining} left ${C.dim(`(was ${drop.body.remaining})`)}\n`);

  if (got === 0 && after.body.remaining === drop.body.remaining) {
    console.log(`  ${C.green('PASS')} — the gate held. An anonymous bot gets nothing.`);
    console.log(C.dim('  This is the baseline every CAPTCHA already achieves.'));
    console.log(C.dim('  The point of deCAPTCHA is what happens next: the same script,\n' +
                      '  carrying a vouch from a verified human, should sail through — and\n' +
                      '  still be capped, expirable and revocable.\n'));
    process.exit(0);
  }
  console.log(`  ${C.red('FAIL')} — the bot got through. The gate is not doing its job.\n`);
  process.exit(1);
}

main().catch((e) => {
  console.error(C.red(`\n  raw-bot could not reach the gate at ${BASE}`));
  console.error(C.dim(`  ${e.message}`));
  console.error(C.dim('  Start it with:  npm run dev\n'));
  process.exit(2);
});
