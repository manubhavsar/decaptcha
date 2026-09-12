/* Demo drop page. Deliberately knows nothing about vouches — a real site would
   not. It calls /api/claim; the gate decides. The Chrome extension (build step 7)
   attaches a vouch to that same request from the outside. */

const $ = (id) => document.getElementById(id);
const api = (p, o) => fetch(p, o).then(async (r) => ({ status: r.status, body: await r.json() }));

let challengeId = null;
let shownAt = 0;

/* Behavioural signal: how much real cursor movement happened on this page.
   A scripted client posting straight to /api/claim produces none of this. */
let pointerSamples = 0;
let lastPt = null;
addEventListener('pointermove', (e) => {
  if (!lastPt || Math.hypot(e.clientX - lastPt.x, e.clientY - lastPt.y) > 6) {
    pointerSamples += 1;
    lastPt = { x: e.clientX, y: e.clientY };
  }
}, { passive: true });

/* ------------------------------- drop state ------------------------------ */

async function loadDrop() {
  const { body } = await api('/api/drop');
  $('drop-name').textContent = body.drop.name;
  $('drop-blurb').textContent = body.drop.blurb;
  $('total').textContent = body.drop.total;
  paintStock(body.remaining, body.drop.total);
}

function paintStock(remaining, total) {
  $('remaining').textContent = remaining;
  $('bar-fill').style.width = `${(remaining / total) * 100}%`;
  $('claim').disabled = remaining <= 0;
  if (remaining <= 0) $('claim').textContent = 'Sold out';
}

/* --------------------------------- log ----------------------------------- */

function addLog(e) {
  const li = document.createElement('li');
  const kind = ['allow', 'block', 'challenge', 'info'].includes(e.outcome) ? e.outcome : 'info';
  const time = new Date(e.at).toLocaleTimeString([], { hour12: false });

  li.innerHTML = `
    <span class="pip ${kind}"></span>
    <div>
      <span class="who"></span>
      <span class="reason"></span>
      <span class="muted"> · ${time}</span>
      <div class="detail"></div>
    </div>`;
  li.querySelector('.who').textContent = e.actor ?? 'unknown';
  li.querySelector('.reason').textContent = e.reason ?? '';
  li.querySelector('.detail').textContent = e.detail ?? '';

  const list = $('log');
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

async function loadLog() {
  const { body } = await api('/api/log');
  $('log').innerHTML = '';
  body.events.forEach(addLog);
}

new EventSource('/api/stream').onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type !== 'gate') return;
  addLog(msg.entry);
  paintStock(msg.remaining, Number($('total').textContent));
};

/* -------------------------------- verdict -------------------------------- */

function verdict(kind, text) {
  const el = $('verdict');
  el.className = `verdict ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

/* --------------------------------- claim --------------------------------- */

async function claim(extra = {}) {
  const { status, body } = await api('/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorLabel: 'human (browser)', ...extra }),
  });

  if (status === 401 && body.reason === 'challenge_required') {
    await openChallenge();
    return;
  }
  if (body.outcome === 'allow') {
    closeChallenge();
    verdict('allow', `Claimed — pass #${body.claim.serial}. ${body.detail}`);
  } else {
    verdict('block', body.detail);
    $('captcha-error').textContent = body.detail;
    $('captcha-error').hidden = false;
    if (body.reason === 'challenge_expired' || body.detail.includes('burned')) await newChallenge();
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
$('reset').onclick = async () => {
  await api('/api/demo/reset', { method: 'POST' });
  $('verdict').hidden = true;
  closeChallenge();
  await loadDrop();
  await loadLog();
};

loadDrop();
loadLog();
