/* Lumen IT website live-chat widget.
 * Embed on any site with:  <script src="https://portal.lumenmsp.co.uk/static/js/chat-widget.js" defer></script>
 * Bot collects Name -> Email -> Phone -> Support/Sales, then hands off to a human; messages are
 * answered by staff in the portal Chat console. Talks back to the portal it was loaded from. */
(function () {
  if (window.__lumenChatLoaded) return;
  window.__lumenChatLoaded = true;

  var BASE = (function () {
    try { return new URL(document.currentScript.src).origin; } catch (e) { return ''; }
  })();
  var LS = 'lumenChat';
  var token = null, lastId = 0, pollTimer = null, state = 'ask_name';
  var data = { name: '', email: '', phone: '', department: '' };

  // ── styles ───────────────────────────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent = [
    '#lcBubble{position:fixed;right:24px;bottom:24px;z-index:2147483000;width:84px;height:84px;border-radius:50%;background:linear-gradient(135deg,#10b981,#2563eb);color:#fff;border:none;box-shadow:0 10px 30px rgba(2,6,23,.45);font-size:40px;cursor:pointer}',
    '#lcPanel{position:fixed;right:24px;bottom:120px;z-index:2147483000;width:440px;max-width:calc(100vw - 32px);height:640px;max-height:calc(100vh - 150px);background:#fff;border-radius:18px;box-shadow:0 20px 56px rgba(2,6,23,.4);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '#lcHead{background:linear-gradient(135deg,#10b981,#2563eb);color:#fff;padding:16px 18px;display:flex;align-items:center;justify-content:space-between}',
    '#lcHead h3{margin:0;font-size:16px;font-weight:700}#lcHead p{margin:2px 0 0;font-size:12px;opacity:.85}',
    '#lcHead button{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1}',
    '#lcBody{flex:1;overflow-y:auto;padding:14px;background:#f8fafc}',
    '.lcMsg{margin:0 0 10px;display:flex}.lcMsg .b{max-width:78%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}',
    '.lcMsg.them{justify-content:flex-start}.lcMsg.them .b{background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-bottom-left-radius:4px}',
    '.lcMsg.me{justify-content:flex-end}.lcMsg.me .b{background:#2563eb;color:#fff;border-bottom-right-radius:4px}',
    '.lcMsg.sys{justify-content:center}.lcMsg.sys .b{background:#e2e8f0;color:#475569;font-size:12px;border-radius:10px}',
    '#lcFoot{padding:10px;border-top:1px solid #e2e8f0;display:flex;gap:8px;background:#fff}',
    '#lcFoot input{flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}',
    '#lcFoot button{background:#2563eb;color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer}',
    '.lcChoice{display:flex;gap:8px;padding:0 14px 14px}.lcChoice button{flex:1;background:#fff;border:1.5px solid #2563eb;color:#2563eb;border-radius:10px;padding:11px 0;font-weight:600;font-size:14px;cursor:pointer}',
    '.lcChoice button:hover{background:#2563eb;color:#fff}'
  ].join('');
  document.head.appendChild(css);

  var ONLINE = true;   // set from /api/chat/config (within 9–5 Mon–Fri hours)
  var bubble = document.createElement('button');
  bubble.id = 'lcBubble'; bubble.textContent = '💬'; bubble.title = 'Chat with us';
  bubble.style.display = 'none';   // hidden until config confirms the chat bot is enabled
  document.body.appendChild(bubble);

  var panel = document.createElement('div');
  panel.id = 'lcPanel';
  panel.innerHTML =
    '<div id="lcHead"><div><h3>Chat with a real person</h3><p>Real Lumen IT staff — no bots 🙌 We reply in minutes.</p></div><button id="lcClose">×</button></div>' +
    '<div id="lcBody"></div>' +
    '<div class="lcChoice" id="lcChoice" style="display:none"></div>' +
    '<div id="lcFoot"><input id="lcInput" placeholder="Type your message…" autocomplete="off"><button id="lcSend">Send</button></div>';
  document.body.appendChild(panel);

  // In the portal the staff softphone launcher sits at right:132px — pair the chat bubble next to
  // it (corner side) and align the bottoms. On the public website (no softphone) stay in the corner.
  if (document.getElementById('wpLauncher')) {
    bubble.style.right = '62px'; bubble.style.bottom = '22px';
    panel.style.right = '62px';
  }

  var body = panel.querySelector('#lcBody');
  var input = panel.querySelector('#lcInput');
  var choice = panel.querySelector('#lcChoice');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function add(side, text) {
    var d = document.createElement('div'); d.className = 'lcMsg ' + side;
    d.innerHTML = '<div class="b">' + esc(text) + '</div>'; body.appendChild(d); body.scrollTop = body.scrollHeight;
  }
  function botSay(t) { add('them', t); }
  function showChoices(opts) {
    choice.style.display = 'flex'; choice.innerHTML = '';
    opts.forEach(function (o) {
      var b = document.createElement('button'); b.textContent = o.label;
      b.onclick = function () { choice.style.display = 'none'; choice.innerHTML = ''; o.onClick(); };
      choice.appendChild(b);
    });
  }

  function open() {
    panel.style.display = 'flex'; bubble.style.display = 'none';
    if (!body.childElementCount) startBot();
  }
  function close() { panel.style.display = 'none'; bubble.style.display = 'block'; }
  bubble.onclick = open;
  panel.querySelector('#lcClose').onclick = close;

  // Gate the whole widget on the Marketing → Chat Bot settings. Presence + page-view tracking
  // (below) always run for Website Stats; the chat UI only appears when the bot is ENABLED, and
  // auto-pops / behaves live only within the configured 9–5 Mon–Fri hours.
  fetch(BASE + '/api/chat/config').then(function (r) { return r.json(); }).then(function (cfg) {
    if (!cfg || !cfg.enabled) { try { bubble.remove(); panel.remove(); } catch (e) {} return; }
    ONLINE = !!cfg.online;
    bubble.style.display = 'block';
    // Auto-prompt at most TWICE (across visits/pages) whenever the bot is ENABLED — the hours only
    // change the greeting (live vs "leave a message"). Then leave them alone, but keep tracking
    // where they go (presence + page views run regardless, below). Don't prompt if already chatting.
    try {
      var saved = null; try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) {}
      var pops = parseInt(localStorage.getItem('lumenChatPops') || '0', 10) || 0;
      if (!(saved && saved.token) && pops < 2) {
        setTimeout(function () {
          if (panel.style.display !== 'flex') {
            try { localStorage.setItem('lumenChatPops', String(pops + 1)); } catch (e) {}
            open();
          }
        }, 2500);
      }
    } catch (e) {}
  }).catch(function () { /* on error leave the bubble hidden */ });

  // ── conversation flow — no bot Q&A; connect straight to a human ──────────────────
  function startBot() {
    var saved = null; try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) {}
    if (saved && saved.token) { token = saved.token; lastId = saved.lastId || 0; state = 'live'; resumeLive(); return; }
    if (ONLINE) {
      botSay('Hi 👋 You\'ve reached Lumen IT — real people here, no bots. What can we help with today? Type your message below and we\'ll be right with you.');
    } else {
      botSay('Hi 👋 You\'ve reached Lumen IT. We\'re offline right now — our team is here Mon–Fri, 9am–5pm. Leave your message and contact details and we\'ll come straight back to you.');
    }
    state = 'new';
  }
  function handleInput(text) {
    if (state === 'live') { sendLive(text); return; }
    // First message — create the chat and send it. Connects the visitor straight to the team;
    // the engineer who picks it up asks for name/email/phone.
    add('me', text);
    state = 'live';
    try { localStorage.setItem('lumenChatPops', '2'); } catch (e) {}  // engaged — no more auto-prompts
    fetch(BASE + '/api/chat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ department: 'support' }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.token) throw new Error('no token');
        token = j.token; persist();
        return fetch(BASE + '/api/chat/' + token + '/msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) });
      })
      .then(function () { startPoll(); })
      .catch(function () { botSay('Sorry, something went wrong connecting you. Please email us at sales@lumenmsp.co.uk.'); });
  }

  // ── live chat ────────────────────────────────────────────────────────────────────
  function resumeLive() { add('sys', 'Reconnected to your chat'); startPoll(); }
  function sendLive(text) {
    add('me', text);
    fetch(BASE + '/api/chat/' + token + '/msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) }).catch(function () {});
  }
  function poll() {
    fetch(BASE + '/api/chat/' + token + '/poll?since=' + lastId).then(function (r) { return r.json(); })
      .then(function (j) {
        (j.messages || []).forEach(function (m) {
          lastId = Math.max(lastId, m.id);
          if (m.sender === 'system') return; // internal note, not shown to visitor
          add(m.sender === 'agent' || m.sender === 'bot' ? 'them' : 'me', m.body);
        });
        persist();
        if (j.status === 'closed') {
          add('sys', 'This chat has been closed. Thanks for getting in touch!');
          add('sys', 'Need anything else? Just type below to start a new chat.');
          stopPoll();
          // Clear the dead session so the NEXT message opens a fresh chat (and reaches the
          // team) instead of being posted into the closed one.
          state = 'new'; token = null; lastId = 0;
          try { localStorage.removeItem(LS); } catch (e) {}
        }
      }).catch(function () {});
  }
  function startPoll() { if (pollTimer) return; poll(); pollTimer = setInterval(poll, 3000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function persist() { try { localStorage.setItem(LS, JSON.stringify({ token: token, lastId: lastId })); } catch (e) {} }

  // ── input wiring ───────────────────────────────────────────────────────────────
  function submit() { var t = input.value.trim(); if (!t) return; input.value = ''; handleInput(t); }
  panel.querySelector('#lcSend').onclick = submit;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  // ── consent gate (UK PECR + DUAA 2025) ───────────────────────────────────────────
  // Presence + the persistent visitor ID below carry the RAW IP server-side and build a
  // cross-session profile, so they are "visitor identification" — they run ONLY with the
  // visitor's opt-in (marketing) consent set by the website cookie banner. On the portal
  // itself (authenticated staff) there is no public banner, so tracking stays on.
  function lumenMarketingConsent() {
    try { if (location.hostname === 'portal.lumenmsp.co.uk') return true; } catch (e) {}
    try { var c = JSON.parse(localStorage.getItem('lumenConsent') || 'null'); return !!(c && c.marketing); } catch (e) { return false; }
  }

  // ── presence heartbeat — lets staff see who's on the site + which page (opt-in only) ──
  function startPresence() {
    var VID = (function () {
      try { var k = 'lumenChatVid', v = localStorage.getItem(k);
        if (!v) { v = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem(k, v); }
        return v; } catch (e) { return 'v' + Date.now(); }
    })();
    function ping() {
      fetch(BASE + '/api/chat/presence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ visitor_id: VID, page: location.pathname, title: document.title,
          lang: navigator.language || '', screen: (window.screen ? screen.width + 'x' + screen.height : '') })
      }).catch(function () {});
    }
    ping(); setInterval(ping, 20000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });

    // Log a single page view (for Marketing → Website Stats). referrer = where they came from.
    fetch(BASE + '/api/chat/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ visitor_id: VID, page: location.pathname, title: document.title, referrer: document.referrer || '' })
    }).catch(function () {});
  }

  if (lumenMarketingConsent()) {
    startPresence();
  } else {
    // Start tracking immediately if the visitor later opts in, without a page reload.
    window.addEventListener('lumen-consent-changed', function (e) {
      if (e && e.detail && e.detail.marketing) startPresence();
    });
  }
})();
