/**
 * deCAPTCHA widget — drop-in replacement for a reCAPTCHA box.
 *
 *   <script src="https://your-gate/decaptcha.js" async defer></script>
 *   <div class="decaptcha" data-sitekey="dcap_demo_site"></div>
 *
 * Two kinds of visitor arrive at this box.
 *
 * A human clicks it and types the characters, exactly as they do today.
 *
 * An agent presents a vouch — an ENS subname proving a verified human is
 * accountable for it — and passes without a challenge, but only as many times
 * as that human allowed, only until the expiry they set, and only until they
 * revoke it. An agent can present its vouch either as a header on its own
 * requests or, when it is driving a real browser, by calling
 * window.decaptcha.present({ vouchName, agentAddress }) before submitting.
 *
 * Everything renders inside a shadow root so the host page's CSS cannot break
 * it and this cannot leak styles into the host page.
 */

(() => {
  const script = document.currentScript
    ?? [...document.querySelectorAll('script[src*="decaptcha.js"]')].pop();
  const ORIGIN = new URL(script?.src ?? 'http://localhost:8787', location.href).origin;

  const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
.box{
  width:330px;background:#111114;border:1px solid #26262E;border-radius:12px;
  color:#EDEDF2;font-size:14px;line-height:1.45;overflow:hidden;
  transition:border-color .18s;
}
.box.ok{border-color:#1F5C45}
.box.bad{border-color:#5C2626}
.row{display:flex;align-items:center;gap:11px;padding:13px 14px}
.check{
  flex:none;width:26px;height:26px;border-radius:6px;border:2px solid #3A3A46;
  background:#17171D;cursor:pointer;display:grid;place-items:center;transition:.18s;
}
.check:hover{border-color:#4D4D5C}
.check.busy{border-color:#34D399;border-right-color:transparent;border-radius:50%;
  animation:spin .7s linear infinite;cursor:default}
.check.done{background:#34D399;border-color:#34D399;cursor:default}
.check.fail{background:#F87171;border-color:#F87171;cursor:pointer}
@keyframes spin{to{transform:rotate(360deg)}}
.check svg{display:block}
.label{flex:1;min-width:0;cursor:pointer;user-select:none}
.label .t{font-weight:500;white-space:nowrap}
.label .s{display:block;color:#8A8A96;font-size:11.5px;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.label .s.good{color:#34D399}
.label .s.bad{color:#F87171}
.mark{flex:none;text-align:right;font-size:8.5px;letter-spacing:.05em;color:#54545F;line-height:1.25}
.mark b{display:block;font-size:10.5px;letter-spacing:-.01em;color:#7E7E8A;font-weight:600}

.panel{border-top:1px solid #26262E;padding:15px;display:none}
.panel.open{display:block}
img.cap{display:block;width:100%;height:auto;border-radius:8px;background:#F6F7FA;border:1px solid #26262E}
.entry{display:flex;gap:8px;margin-top:12px}
input{
  flex:1;min-width:0;background:#17171D;border:1px solid #2C2C36;color:#EDEDF2;
  border-radius:8px;padding:10px 12px;font:600 15px/1 ui-monospace,Menlo,monospace;
  letter-spacing:.22em;text-transform:uppercase;
}
input::placeholder{letter-spacing:normal;font-weight:400;font-size:13px;color:#6A6A76}
input:focus{outline:0;border-color:#34D399}
button{font:inherit;cursor:pointer;border-radius:8px;transition:.14s}
.refresh{flex:none;width:40px;background:transparent;border:1px solid #2C2C36;color:#8A8A96;font-size:15px}
.refresh:hover{color:#EDEDF2;border-color:#3D3D48}
.go{width:100%;margin-top:10px;background:#34D399;color:#04150E;border:0;padding:10px;font-weight:600}
.go:hover{background:#48E3AB}
.err{margin-top:10px;color:#F87171;font-size:12.5px}
.err:empty{display:none}
`;

  const TICK = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
    + '<path d="M3 8l3.2 3.2L12 5" stroke="#04150E" stroke-width="2.4" '
    + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** Set by an agent driving a browser, before it triggers verification. */
  let presented = null;

  class Widget {
    constructor(el) {
      this.el = el;
      this.sitekey = el.dataset.sitekey || '';
      this.token = null;
      this.challengeId = null;
      this.shownAt = 0;

      // Behavioural signal, same as the standalone gate: a client that never
      // moved a pointer has not been driven by a person.
      this.pointer = 0;
      let last = null;
      addEventListener('pointermove', (e) => {
        if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 6) {
          this.pointer += 1;
          last = { x: e.clientX, y: e.clientY };
        }
      }, { passive: true });

      this.mount();
      this.probe();
    }

    mount() {
      const root = this.el.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style>
        <div class="box">
          <div class="row">
            <div class="check" part="check"></div>
            <div class="label">
              <span class="t">I'm not a bot</span>
              <span class="s">or a human vouched for me</span>
            </div>
            <div class="mark"><b>deCAPTCHA</b>human<br>or vouched agent</div>
          </div>
          <div class="panel">
            <img class="cap" alt="Type the characters shown" />
            <div class="entry">
              <input maxlength="6" autocomplete="off" spellcheck="false" placeholder="6 characters" />
              <button class="refresh" title="New challenge">&#8635;</button>
            </div>
            <button class="go">Verify</button>
            <div class="err"></div>
          </div>
        </div>`;

      const $ = (s) => root.querySelector(s);
      this.ui = {
        box: $('.box'), check: $('.check'), title: $('.t'), sub: $('.s'),
        panel: $('.panel'), img: $('.cap'), input: $('input'),
        refresh: $('.refresh'), go: $('.go'), err: $('.err'),
      };

      const open = () => { if (!this.token) this.openChallenge(); };
      this.ui.check.onclick = open;
      $('.label').onclick = open;
      this.ui.refresh.onclick = () => this.newChallenge();
      this.ui.go.onclick = () => this.solve();
      this.ui.input.onkeydown = (e) => { if (e.key === 'Enter') this.solve(); };
    }

    post(path, body) {
      return fetch(ORIGIN + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sitekey: this.sitekey, ...body }),
      }).then((r) => r.json());
    }

    state(cls, title, sub, subCls = '') {
      this.ui.box.className = `box ${cls === 'done' ? 'ok' : cls === 'fail' ? 'bad' : ''}`.trim();
      this.ui.check.className = `check ${cls}`.trim();
      this.ui.check.innerHTML = cls === 'done' ? TICK : '';
      this.ui.title.textContent = title;
      this.ui.sub.textContent = sub;
      this.ui.sub.className = `s ${subCls}`.trim();
    }

    /** Ask, before showing anyone a challenge, whether this visitor is vouched. */
    async probe() {
      this.state('busy', 'Checking…', 'Looking for a credential');
      let r;
      try {
        r = await this.post('/api/widget/probe', presented ?? {});
      } catch {
        this.state('', "I'm not a bot", 'Gate unreachable', 'bad');
        return;
      }

      if (r.outcome === 'allow') {
        this.token = r.token;
        this.ui.panel.classList.remove('open');
        this.state('done', 'Verified agent',
          `for ${r.actingFor} · ${r.scope.used}/${r.scope.max}`, 'good');
        this.emit(r);
        return;
      }

      const why = r.reason && r.reason !== 'no_credential'
        ? { vouch_revoked: 'That vouch was revoked', vouch_expired: 'That vouch has expired',
            scope_exceeded: 'That vouch is used up', vouch_unknown: 'That credential is not valid',
            vouch_wrong_agent: 'That vouch belongs to another agent' }[r.reason] ?? 'Credential rejected'
        : null;

      this.state('', "I'm not a bot", why ?? 'or a human vouched for me', why ? 'bad' : '');
    }

    async openChallenge() {
      this.ui.panel.classList.add('open');
      await this.newChallenge();
    }

    async newChallenge() {
      const r = await fetch(`${ORIGIN}/api/widget/challenge?sitekey=${encodeURIComponent(this.sitekey)}`)
        .then((x) => x.json());
      this.challengeId = r.challengeId;
      this.ui.img.src = r.image;
      this.ui.input.value = '';
      this.ui.err.textContent = '';
      this.shownAt = Date.now();
      this.ui.input.focus();
    }

    async solve() {
      const r = await this.post('/api/widget/solve', {
        challengeId: this.challengeId,
        answer: this.ui.input.value,
        behavior: { elapsedMs: Date.now() - this.shownAt, pointerSamples: this.pointer },
      });

      if (r.outcome === 'allow') {
        this.token = r.token;
        this.ui.panel.classList.remove('open');
        this.state('done', 'Verified human', 'challenge solved', 'good');
        this.emit(r);
        return;
      }

      this.ui.err.textContent = r.detail ?? 'Verification failed.';
      if (r.reason === 'challenge_expired' || /burned/.test(r.detail ?? '')) await this.newChallenge();
    }

    /** Hand the token to the host page, the way reCAPTCHA does. */
    emit(result) {
      let field = this.el.querySelector('input[name="decaptcha-response"]');
      if (!field) {
        field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'decaptcha-response';
        this.el.appendChild(field);
      }
      field.value = this.token;

      const cb = this.el.dataset.callback;
      if (cb && typeof window[cb] === 'function') window[cb](this.token, result);
      this.el.dispatchEvent(new CustomEvent('decaptcha:verified', { detail: result, bubbles: true }));
    }

    reset() {
      this.token = null;
      this.ui.panel.classList.remove('open');
      this.state('', "I'm not a bot", 'or a human vouched for me');
    }
  }

  const widgets = [];

  function render(root = document) {
    for (const el of root.querySelectorAll('.decaptcha:not([data-dcap-ready])')) {
      el.setAttribute('data-dcap-ready', '1');
      widgets.push(new Widget(el));
    }
  }

  window.decaptcha = {
    render,
    reset: () => widgets.forEach((w) => w.reset()),
    getResponse: (i = 0) => widgets[i]?.token ?? null,

    /**
     * How an agent driving a browser presents its credential. A headless agent
     * calling the API directly sends the same values as X-Decaptcha-Vouch and
     * X-Decaptcha-Agent headers instead.
     */
    present(credential) {
      presented = credential;
      return Promise.all(widgets.map((w) => w.probe()));
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => render());
  } else {
    render();
  }
})();
