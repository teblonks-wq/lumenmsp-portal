/* Lumen Chat — the AGENT end of the website chat bot (portal, staff only).
 * A floating launcher (next to the softphone) opens a panel listing active website chats;
 * the agent opens one and replies in real time. Polls the same endpoints the console uses. */
(function () {
  if (window.__lumenAgentChat) return;
  window.__lumenAgentChat = true;

  var openId = null;          // currently-open chat id (null = list view)
  var lastMsgId = 0;          // last message id seen in the open thread
  var listTimer = null, threadTimer = null;

  var css = document.createElement('style');
  css.textContent = [
    '#acLauncher{position:fixed;right:80px;top:14px;z-index:9997;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#10b981,#2563eb);color:#fff;border:none;box-shadow:0 6px 18px rgba(2,6,23,.35);font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '#acBadge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;border:2px solid #fff}',
    '#acPanel{position:fixed;right:24px;top:70px;z-index:9998;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 130px);background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(2,6,23,.35);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '#acHead{background:linear-gradient(135deg,#10b981,#2563eb);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:8px}',
    '#acHead h3{margin:0;font-size:15px;font-weight:700;flex:1}',
    '#acHead button{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1}',
    '#acBody{flex:1;overflow-y:auto;background:#f8fafc}',
    '.acRow{padding:12px 14px;border-bottom:1px solid #eef2f7;cursor:pointer}',
    '.acRow:hover{background:#eef6ff}',
    '.acRow .nm{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px}',
    '.acRow .sn{font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
    '.acTag{font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:6px;background:#dbeafe;color:#1d4ed8}',
    '.acTag.sales{background:#dcfce7;color:#15803d}',
    '.acUnread{background:#ef4444;color:#fff;border-radius:9px;font-size:11px;padding:1px 6px;font-weight:700}',
    '.acEmpty{padding:22px 16px;color:#64748b;font-size:14px;text-align:center}',
    '.acMsg{margin:0 0 10px;display:flex;padding:0 12px}.acMsg .b{max-width:80%;padding:8px 11px;border-radius:13px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}',
    '.acMsg.them{justify-content:flex-start}.acMsg.them .b{background:#fff;color:#0f172a;border:1px solid #e2e8f0}',
    '.acMsg.me{justify-content:flex-end}.acMsg.me .b{background:#2563eb;color:#fff}',
    '.acMsg.sys{justify-content:center}.acMsg.sys .b{background:#e2e8f0;color:#475569;font-size:12px}',
    '#acThread{flex:1;overflow-y:auto;padding:12px 0;background:#f8fafc}',
    '#acFoot{padding:10px;border-top:1px solid #e2e8f0;display:flex;gap:8px;background:#fff}',
    '#acFoot input{flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;font-size:14px;outline:none}',
    '#acFoot button{background:#2563eb;color:#fff;border:none;border-radius:10px;padding:0 14px;font-weight:600;cursor:pointer}',
    '.acConvert{display:flex;gap:6px;padding:8px 12px;border-top:1px solid #eef2f7;background:#fff}',
    '.acConvert a{flex:1;text-align:center;font-size:12px;font-weight:600;padding:7px 0;border-radius:8px;border:1px solid #cbd5e1;color:#334155;text-decoration:none}'
  ].join('');
  document.head.appendChild(css);

  var launcher = document.createElement('button');
  launcher.id = 'acLauncher'; launcher.title = 'Lumen Chat'; launcher.innerHTML = '💬<span id="acBadge">0</span>';
  document.body.appendChild(launcher);

  var panel = document.createElement('div');
  panel.id = 'acPanel';
  document.body.appendChild(panel);

  var badge = launcher.querySelector('#acBadge');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  launcher.onclick = function () {
    if (panel.style.display === 'flex') { panel.style.display = 'none'; return; }
    panel.style.display = 'flex'; openId = null; renderList();
  };

  // ── list view ──────────────────────────────────────────────────────────────────
  function renderList() {
    openId = null; if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
    panel.innerHTML = '<div id="acHead"><h3>💬 Lumen Chat</h3><button id="acX">×</button></div><div id="acBody"><div class="acEmpty">Loading…</div></div>';
    panel.querySelector('#acX').onclick = function () { panel.style.display = 'none'; };
    loadList();
  }
  function loadList() {
    fetch('/chat/list.json').then(function (r) { return r.json(); }).then(function (rows) {
      updateBadge(rows);
      if (openId !== null) return;            // user opened a chat meanwhile
      var body = panel.querySelector('#acBody'); if (!body) return;
      if (!rows.length) { body.innerHTML = '<div class="acEmpty">No active chats right now.</div>'; return; }
      body.innerHTML = rows.map(function (s) {
        var dept = (s.department === 'sales') ? 'sales' : 'support';
        return '<div class="acRow" data-id="' + s.id + '"><div class="nm">' + esc(s.name || s.email || 'Visitor') +
          ' <span class="acTag ' + dept + '">' + dept + '</span>' + (s.unread > 0 ? ' <span class="acUnread">' + s.unread + '</span>' : '') +
          (!s.assigned_user_id ? ' <span class="acTag" style="background:#fee2e2;color:#b91c1c;">new</span>' : '') +
          '</div><div class="sn">' + esc(s.last_body || '') + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(body.querySelectorAll('.acRow'), function (el) {
        el.onclick = function () { openChat(parseInt(el.getAttribute('data-id'), 10), el.querySelector('.nm').textContent.trim()); };
      });
    }).catch(function () {});
  }
  function updateBadge(rows) {
    var n = rows.filter(function (s) { return s.unread > 0 || !s.assigned_user_id; }).length;
    badge.textContent = n; badge.style.display = n > 0 ? 'flex' : 'none';
  }

  // ── thread view ────────────────────────────────────────────────────────────────
  function openChat(id, name) {
    openId = id; lastMsgId = 0;
    fetch('/chat/' + id + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {});
    panel.innerHTML =
      '<div id="acHead"><button id="acBack" title="Back">‹</button><h3>' + esc(name || 'Chat') + '</h3><a href="/chat/' + id + '" title="Full view" style="color:#fff;text-decoration:none;font-size:16px;">⤢</a></div>' +
      '<div id="acThread"></div>' +
      '<div class="acConvert"><a href="/chat/' + id + '">Open full view → ticket / lead / quote</a></div>' +
      '<div id="acFoot"><input id="acInput" placeholder="Type your reply…" autocomplete="off"><button id="acSend">Send</button></div>';
    panel.querySelector('#acBack').onclick = renderList;
    var input = panel.querySelector('#acInput');
    panel.querySelector('#acSend').onclick = function () { sendReply(id, input); };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendReply(id, input); } });
    pollThread(id);
    if (threadTimer) clearInterval(threadTimer);
    threadTimer = setInterval(function () { pollThread(id); }, 3000);
  }
  function bubble(m) {
    var th = panel.querySelector('#acThread'); if (!th) return;
    var side = m.sender === 'agent' ? 'me' : (m.sender === 'visitor' ? 'them' : 'sys');
    var d = document.createElement('div'); d.className = 'acMsg ' + side;
    d.innerHTML = '<div class="b"></div>'; d.querySelector('.b').textContent = m.body;
    th.appendChild(d); th.scrollTop = th.scrollHeight;
  }
  function pollThread(id) {
    if (openId !== id) return;
    fetch('/chat/' + id + '/poll?since=' + lastMsgId).then(function (r) { return r.json(); }).then(function (j) {
      (j.messages || []).forEach(function (m) { lastMsgId = Math.max(lastMsgId, m.id); bubble(m); });
      if (j.status === 'closed') { var f = panel.querySelector('#acFoot'); if (f) f.style.display = 'none'; }
    }).catch(function () {});
  }
  function sendReply(id, input) {
    var t = input.value.trim(); if (!t) return; input.value = '';
    fetch('/chat/' + id + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ body: t }) })
      .then(function () { pollThread(id); }).catch(function () {});
  }

  // Background: keep the badge fresh even when the panel is closed.
  loadList();
  listTimer = setInterval(function () { if (openId === null) loadList(); else fetch('/chat/list.json').then(function (r) { return r.json(); }).then(updateBadge).catch(function () {}); }, 6000);
})();
