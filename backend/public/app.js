/* Demo gate — client.
   This page knows nothing about vouches, on purpose: a real site wouldn't. It
   posts a claim and renders whatever the gate decides. The vouch panel below is
   a read-only inspector, so the ENS state on screen is what the chain says
   rather than what this page believes. */

const $ = (id) => document.getElementById(id);
const api = (p, o) => fetch(p, o).then(async (r) => ({ status: r.status, body: await r.json() }));

let challengeId = null;
let shownAt = 0;
let total = 0;

/* Behavioural signal. A client that never opened a browser produces none. */
let pointerSamples = 0;
let lastPt = null;
addEventListener('pointermove', (e) => {
  if (!lastPt || Math.hypot(e.clientX - lastPt.x, e.clientY - lastPt.y) > 6) {
    pointerSamples += 1;
    lastPt = { x: e.clientX, y: e.clientY };
  }
}, { passive: true });

/* --------------------------------- chrome -------------------------------- */

async function loadChainTag() {
  try {
    const { body } = await api('/api/vouch/status');
    const t = $('chain-tag');
    if (body.wired) {
      t.textContent = `ENSv2 · sepolia · ${body.chainId}`;
      t.className = 'tag live';
    } else {
      t.textContent = 'chain not configured';
      t.className = 'tag off';
    }
  } catch {
    $('chain-tag').textContent = 'gate offline';
  }
}

async function loadDrop() {
  const { body } = await api('/api/drop');
  $('drop-name').textContent = body.drop.name;
  $('drop-blurb').textContent = body.drop.blurb;
  total = body.drop.total;
  $('total').textContent = total;
  paintStock(body.remaining);
}

function paintStock(remaining) {
  $('remaining').textContent = remaining;
  $('track-fill').style.width = `${(remaining / total) * 100}%`;
  const b = $('claim');
  b.disabled = remaining <= 0;
  if (remaining <= 0) b.textContent = 'Sold out';
}

/* ---------------------------------- log ---------------------------------- */

function addLog(e) {
  const list = $('log');
  list.querySelector('.empty')?.remove();

  const kind = ['allow', 'block', 'challenge', 'info'].includes(e.outcome) ? e.outcome : 'info';
  const li = document.createElement('li');
  li.innerHTML = `
    <span class="pip ${kind}"></span>
    <div>
      <div class="top">
        <span class="who"></span>
        <span class="code"></span>
        <span class="at"></span>
      </div>
      <div class="detail"></div>
    </div>`;
  li.querySelector('.who').textContent = e.actor ?? 'unknown';
  li.querySelector('.code').textContent = e.reason ?? '';
  li.querySelector('.at').textContent = new Date(e.at).toLocaleTimeString([], { hour12: false });
  li.querySelector('.detail').textContent = e.detail ?? '';

  if (e.txUrl) {
    const a = document.createElement('a');
    a.className = 'link tx';
    a.href = e.txUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'View transaction on Etherscan →';
    li.querySelector('div').appendChild(a);
  }

  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

async function loadLog() {
  const { body } = await api('/api/log');
  $('log').innerHTML = body.events.length ? '' : '<li class="empty">Waiting for the first request…</li>';
  body.events.forEach(addLog);
}

/* ----------------------------- vouch inspector --------------------------- */

let watching = null;

async function showVouch(name) {
  if (!name) return;
  watching = name;
  const { body: v } = await api(`/api/vouch/${encodeURIComponent(name)}`);

  $('vouch-card').hidden = false;
  $('vouch-name').textContent = name;
  $('vouch-latency').textContent = v.latencyMs ? `read in ${v.latencyMs}ms · no cache` : '';

  if (!v.found) {
    setRow('v-status', v.reason ?? 'not found', 'bad');
    return;
  }

  setRow('v-scope', `${v.scopeMaxClaims} claim${v.scopeMaxClaims === 1 ? '' : 's'}`);
  setRow('v-expiry', v.expiresAt ? new Date(v.expiresAt).toLocaleString() : '—', v.expired ? 'bad' : '');
  setRow('v-cred', v.credentialRef ?? '—', 'mono');
  setRow('v-human', v.humanAddress ?? '—', 'mono');
  setRow('v-status',
    v.revoked ? 'revoked' : v.expired ? 'expired' : 'active',
    v.revoked || v.expired ? 'bad' : 'ok');

  if (v.resolverUrl) $('v-explorer').href = v.resolverUrl;
  paintPermissions(v.permissions);
}

function setRow(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `v ${cls}`.trim();
}

function paintPermissions(perm) {
  const ul = $('perm-rows');
  ul.innerHTML = '';
  if (!perm?.rows?.length) {
    ul.innerHTML = '<li class="who">Permission data unavailable.</li>';
    return;
  }
  for (const r of perm.rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="who"></span><code></code><span></span>';
    li.children[0].textContent = r.account;
    li.children[1].textContent = r.key.replace('decaptcha.', '');
    li.children[2].textContent = r.canWrite ? 'can write' : 'no access';
    li.children[2].className = r.canWrite ? 'yes' : 'no';
    ul.appendChild(li);
  }
}

/* --------------------------------- stream -------------------------------- */

new EventSource('/api/stream').onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type !== 'gate') return;
  addLog(msg.entry);
  paintStock(msg.remaining);

  // Any event naming a vouch is a reason to re-read it from chain — this is how
  // a revoke made elsewhere shows up here without a refresh.
  if (msg.entry.vouchName) showVouch(msg.entry.vouchName);
};

/* -------------------------------- verdict -------------------------------- */

const MARKS = { allow: '✓', block: '✕', challenge: '!' };

function verdict(kind, text) {
  const el = $('verdict');
  el.className = `verdict ${kind}`;
  el.querySelector('.mark').textContent = MARKS[kind] ?? '';
  el.querySelector('.verdict-text').textContent = text;
  el.hidden = false;
}

/* --------------------------------- claim --------------------------------- */

async function claim(extra = {}) {
  const { status, body } = await api('/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorLabel: 'human (browser)', ...extra }),
  });

  if (status === 401 && body.reason === 'challenge_required') return openChallenge();

  if (body.outcome === 'allow') {
    closeChallenge();
    verdict('allow', `Claimed — pass #${body.claim.serial}. ${body.detail}`);
    return;
  }

  verdict('block', body.detail);
  if (!$('modal').hidden) {
    $('captcha-error').textContent = body.detail;
    $('captcha-error').hidden = false;
    if (body.reason === 'challenge_expired' || /burned/.test(body.detail)) await newChallenge();
  }
}

/* ------------------------------- challenge ------------------------------- */

async function newChallenge() {
  const { body } = await api('/api/challenge');
  challengeId = body.challengeId;
  $('captcha-img').src = body.image;
  $('captcha-input').value = '';
  $('captcha-error').hidden = true;
  shownAt = Date.now();
  $('captcha-input').focus();
}

async function openChallenge() {
  $('modal').hidden = false;
  verdict('challenge', 'No vouch presented. Prove you are human to continue.');
  await newChallenge();
}

function closeChallenge() {
  $('modal').hidden = true;
  challengeId = null;
}

/* --------------------------------- wiring -------------------------------- */

$('claim').onclick = () => claim();
$('captcha-cancel').onclick = closeChallenge;
$('captcha-refresh').onclick = newChallenge;
$('captcha-submit').onclick = () => claim({
  challengeId,
  answer: $('captcha-input').value,
  behavior: { elapsedMs: Date.now() - shownAt, pointerSamples },
});
$('captcha-input').onkeydown = (e) => { if (e.key === 'Enter') $('captcha-submit').click(); };
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeChallenge(); });

$('reset').onclick = async () => {
  await api('/api/demo/reset', { method: 'POST' });
  $('verdict').hidden = true;
  closeChallenge();
  await loadDrop();
  await loadLog();
};

loadChainTag();
loadDrop();
loadLog();

// If a vouch has already been minted in this session, show it straight away.
api('/api/vouch/status').then(({ body }) => {
  if (body.write?.ready) fetch('/api/log').then((r) => r.json()).then((d) => {
    const last = [...d.events].reverse().find((e) => e.vouchName);
    if (last) showVouch(last.vouchName);
  });
});
