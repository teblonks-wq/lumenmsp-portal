/* WhatsApp softphone — portal-wide call widget.
 * Inbound: WhatsApp sends an SDP offer, we answer. Outbound (call-back): we send an SDP
 * offer, the customer answers. Media is browser <-> WhatsApp; this widget only signals to
 * our server over /ws/calls. Call-back is only allowed inside the 24h service window (server
 * enforces it; the history list shows which contacts are still callable). */
(function () {
  if (window.__waPhoneLoaded) return;
  window.__waPhoneLoaded = true;

  var ws = null, reconnectTimer = null;
  var pc = null, localStream = null, remoteAudio = null;
  var current = null;          // active call { callId, name, peer, offerSdp?, direction }
  var iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  var ringCtx = null, ringTimer = null, durTimer = null, connectedAt = 0;
  var panelOpen = false, view = null;   // view: 'incoming' | 'calling' | 'incall' | 'panel' | null
  var chatToasts = {};                  // sessionId -> toast element (so a claimed chat dismisses everywhere)
  var pendingChats = {};                // sessionId -> true while a chat is unclaimed (drives the nav flash)

  // ── styles ───────────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#wpLauncher{position:fixed;right:24px;top:14px;z-index:9998;width:46px;height:46px;border-radius:50%;background:#22c55e;color:#fff;border:none;box-shadow:0 6px 18px rgba(2,6,23,.35);font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '#wpLauncher:hover{filter:brightness(1.05)}',
    '#waphone{position:fixed;right:24px;top:70px;z-index:9999;width:360px;max-width:calc(100vw - 32px);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:none}',
    '#waphone .wp-card{background:#0f172a;color:#fff;border-radius:18px;box-shadow:0 18px 48px rgba(2,6,23,.55);border:1px solid #1e293b;overflow:hidden}',
    '#waphone .wp-pad{padding:22px}',
    '#waphone .wp-icon{width:56px;height:56px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:12px}',
    '#waphone .wp-name{font-size:20px;font-weight:700;margin:0;line-height:1.2}',
    '#waphone .wp-sub{font-size:14px;color:#94a3b8;margin:3px 0 18px}',
    '#waphone .wp-row{display:flex;gap:12px}',
    '#waphone button.wp-btn{flex:1;border:none;border-radius:12px;padding:14px 0;font-size:15px;font-weight:600;cursor:pointer;color:#fff}',
    '#waphone .wp-accept{background:#22c55e}#waphone .wp-decline,#waphone .wp-hangup{background:#ef4444}',
    '#waphone .wp-mute{background:#334155}#waphone .wp-mute.on{background:#f59e0b}',
    '#waphone .wp-timer{font-variant-numeric:tabular-nums}',
    '#waphone .wp-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #1e293b}',
    '#waphone .wp-head h3{margin:0;font-size:16px;font-weight:700}',
    '#waphone .wp-x{background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer}',
    '#waphone .wp-dial{display:flex;gap:8px;padding:12px 18px;border-bottom:1px solid #1e293b}',
    '#waphone .wp-dial input{flex:1;background:#1e293b;border:1px solid #334155;border-radius:10px;color:#fff;padding:10px 12px;font-size:14px}',
    '#waphone .wp-dial button{background:#22c55e;border:none;border-radius:10px;color:#fff;padding:0 16px;font-weight:600;cursor:pointer}',
    '#waphone .wp-list{max-height:330px;overflow:auto}',
    '#waphone .wp-item{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid #16213a}',
    '#waphone .wp-item .meta{flex:1;min-width:0}',
    '#waphone .wp-item .nm{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#waphone .wp-item .dt{font-size:12px;color:#94a3b8}',
    '#waphone .wp-cb{background:#22c55e;border:none;border-radius:8px;color:#fff;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer}',
    '#waphone .wp-cb[disabled]{background:#334155;color:#64748b;cursor:not-allowed}',
    '#waphone .wp-empty{padding:22px 18px;color:#94a3b8;font-size:14px;text-align:center}',
    '@keyframes wp-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}#waphone.ringing .wp-icon{animation:wp-pulse 1s infinite}'
  ].join('');
  document.head.appendChild(style);

  var launcher = document.createElement('button');
  launcher.id = 'wpLauncher'; launcher.title = 'Phone'; launcher.textContent = '📞';
  launcher.onclick = function () { if (current) { renderCurrent(); } else { togglePanel(); } };
  document.body.appendChild(launcher);

  // Re-draw the correct call view (used when the launcher is clicked mid-call). Never resets the
  // in-call timer — connectedAt is preserved so the counter keeps running.
  function renderCurrent() {
    if (!current) { togglePanel(); return; }
    if (view === 'incall') showInCall(current);
    else if (view === 'calling') showCalling(current);
    else if (view === 'incoming') showIncoming(current);
    else box.style.display = 'block';
  }

  var box = document.createElement('div');
  box.id = 'waphone';
  document.body.appendChild(box);

  // ── panel (history + dial) ─────────────────────────────────────────────────────
  function togglePanel() { panelOpen = !panelOpen; if (panelOpen) renderPanel(); else hide(); }
  function renderPanel() {
    box.className = ''; box.style.display = 'block';
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    var kp = keys.map(function (k) {
      return '<button class="wp-key" data-k="' + k + '" style="background:#1e293b;border:1px solid #334155;color:#fff;border-radius:10px;padding:13px 0;font-size:19px;cursor:pointer;">' + k + '</button>';
    }).join('');
    box.innerHTML =
      '<div class="wp-card"><div class="wp-head"><h3>📞 WhatsApp calls</h3><button class="wp-x">×</button></div>' +
      '<div class="wp-dial"><input placeholder="07… or 01…" inputmode="tel" style="font-family:monospace;font-size:18px;text-align:center;"><button class="wp-bs" title="Backspace" style="background:#334155;padding:0 14px;">⌫</button></div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 18px 0;">' + kp + '</div>' +
      '<div style="padding:12px 18px;"><button class="wp-callbtn" style="width:100%;background:#22c55e;border:none;border-radius:10px;color:#fff;padding:13px 0;font-weight:700;font-size:15px;cursor:pointer;">📞 Call</button></div>' +
      '<div style="padding:6px 18px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;">Recent calls</div>' +
      '<div class="wp-list" style="max-height:170px;"><div class="wp-empty">Loading…</div></div></div>';
    box.querySelector('.wp-x').onclick = function () { panelOpen = false; hide(); };
    var inp = box.querySelector('.wp-dial input');
    Array.prototype.forEach.call(box.querySelectorAll('.wp-key'), function (b) {
      b.onclick = function () { inp.value += b.getAttribute('data-k'); inp.focus(); };
    });
    box.querySelector('.wp-bs').onclick = function () { inp.value = inp.value.slice(0, -1); inp.focus(); };
    box.querySelector('.wp-callbtn').onclick = function () { if (inp.value.trim()) startOutbound(inp.value.trim(), inp.value.trim()); };
    fetch('/api/calls/history').then(function (r) { return r.json(); }).then(renderList).catch(function () {
      var l = box.querySelector('.wp-list'); if (l) l.innerHTML = '<div class="wp-empty">Could not load history.</div>';
    });
  }
  function fmtWhen(s) {
    var d = new Date(s), now = new Date();
    var t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return 'Today ' + t;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + t;
  }
  function fmtDur(s) { return s ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : ''; }
  function renderList(rows) {
    var l = box.querySelector('.wp-list'); if (!l) return;
    if (!rows || !rows.length) { l.innerHTML = '<div class="wp-empty">No calls yet.</div>'; return; }
    l.innerHTML = rows.map(function (r) {
      var arrow = r.direction === 'outbound' ? '↗' : '↙';
      var name = (r.peer_name && r.peer_name !== r.peer) ? r.peer_name : r.peer;
      var sub = fmtWhen(r.started_at) + ' · ' + (r.status || '') + (r.duration_secs ? ' · ' + fmtDur(r.duration_secs) : '');
      var btn = r.callable
        ? '<button class="wp-cb" data-peer="' + r.peer + '" data-name="' + (name || '').replace(/"/g, '&quot;') + '">Call back</button>'
        : '<button class="wp-cb" disabled title="Outside the 24h window">expired</button>';
      return '<div class="wp-item"><span style="font-size:18px">' + arrow + '</span>' +
        '<div class="meta"><div class="nm">' + escapeHtml(name) + '</div><div class="dt">' + escapeHtml(sub) + '</div></div>' + btn + '</div>';
    }).join('');
    Array.prototype.forEach.call(l.querySelectorAll('.wp-cb[data-peer]'), function (b) {
      b.onclick = function () { startOutbound(b.getAttribute('data-peer'), b.getAttribute('data-name')); };
    });
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ── call cards ──────────────────────────────────────────────────────────────────
  function showIncoming(c) {
    view = 'incoming'; panelOpen = false; box.className = 'ringing'; box.style.display = 'block'; launcher.style.display = 'none';
    box.innerHTML = '<div class="wp-card"><div class="wp-pad"><div class="wp-icon">📞</div>' +
      '<p class="wp-name"></p><p class="wp-sub">Incoming WhatsApp call</p>' +
      '<div class="wp-row"><button class="wp-btn wp-accept">Accept</button><button class="wp-btn wp-decline">Decline</button></div></div></div>';
    box.querySelector('.wp-name').textContent = c.name;
    box.querySelector('.wp-accept').onclick = accept;
    box.querySelector('.wp-decline').onclick = decline;
  }
  function showCalling(c) {
    view = 'calling'; box.className = 'ringing'; box.style.display = 'block'; launcher.style.display = 'none';
    box.innerHTML = '<div class="wp-card"><div class="wp-pad"><div class="wp-icon" style="background:#2563eb">📲</div>' +
      '<p class="wp-name"></p><p class="wp-sub">Calling…</p>' +
      '<div class="wp-row"><button class="wp-btn wp-hangup">Cancel</button></div></div></div>';
    box.querySelector('.wp-name').textContent = c.name;
    box.querySelector('.wp-hangup').onclick = hangup;
  }
  function showInCall(c) {
    view = 'incall'; box.className = ''; box.style.display = 'block'; launcher.style.display = 'none';
    box.innerHTML = '<div class="wp-card"><div class="wp-pad"><div class="wp-icon" style="background:#2563eb">🎧</div>' +
      '<p class="wp-name"></p><p class="wp-sub">On call · <span class="wp-timer">00:00</span></p>' +
      '<div class="wp-row"><button class="wp-btn wp-mute">Mute</button><button class="wp-btn wp-hangup">Hang up</button></div></div></div>';
    box.querySelector('.wp-name').textContent = c.name;
    box.querySelector('.wp-hangup').onclick = hangup;
    box.querySelector('.wp-mute').onclick = toggleMute;
    if (localStream) { var muted = localStream.getAudioTracks().some(function (t) { return !t.enabled; }); var mb = box.querySelector('.wp-mute'); if (muted) { mb.classList.add('on'); mb.textContent = 'Unmute'; } }
    // Preserve the running counter across re-renders — only stamp the start time once.
    if (!connectedAt) connectedAt = Date.now();
    if (durTimer) clearInterval(durTimer);
    durTimer = setInterval(updateTimer, 1000); updateTimer();
  }
  function updateTimer() {
    var el = box.querySelector('.wp-timer'); if (!el) return;
    var s = Math.floor((Date.now() - connectedAt) / 1000);
    el.textContent = ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function hide() { box.style.display = 'none'; box.innerHTML = ''; box.className = ''; view = null; launcher.style.display = 'flex'; if (durTimer) { clearInterval(durTimer); durTimer = null; } }

  // ── ringtone ─────────────────────────────────────────────────────────────────
  function startRing() {
    try {
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      var beep = function () {
        if (!ringCtx) return;
        var o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.frequency.value = 480; o.connect(g); g.connect(ringCtx.destination);
        g.gain.setValueAtTime(0.0001, ringCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.15, ringCtx.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.4);
        o.start(); o.stop(ringCtx.currentTime + 0.45);
      };
      beep(); ringTimer = setInterval(beep, 1500);
    } catch (e) {}
  }
  function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } try { if (ringCtx) { ringCtx.close(); ringCtx = null; } } catch (e) {} }

  // ── media / peer connection ────────────────────────────────────────────────────
  function newPc() {
    pc = new RTCPeerConnection({ iceServers: iceServers });
    pc.ontrack = function (e) {
      if (!remoteAudio) { remoteAudio = document.createElement('audio'); remoteAudio.autoplay = true; document.body.appendChild(remoteAudio); }
      remoteAudio.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = function () {
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) cleanupMedia();
    };
  }
  function waitIceComplete() {
    return new Promise(function (resolve) {
      if (!pc || pc.iceGatheringState === 'complete') return resolve();
      var done = false, finish = function () { if (done) return; done = true; resolve(); };
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') finish(); });
      setTimeout(finish, 2000);
    });
  }
  function getMic() { return navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  function micError(err) { alert('Could not start the call: ' + (err && err.message || err) + '\n(Allow microphone access for the portal, and make sure a mic is connected.)'); }

  // ── inbound accept ─────────────────────────────────────────────────────────────
  function accept() {
    if (!current) return; stopRing();
    getMic().then(function (stream) {
      localStream = stream; newPc();
      stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      return pc.setRemoteDescription({ type: 'offer', sdp: current.offerSdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(waitIceComplete)
        .then(function () { sendWs({ type: 'accept', callId: current.callId, answerSdp: pc.localDescription.sdp }); });
    }).catch(function (err) { micError(err); decline(); });
  }

  // ── outbound call-back ─────────────────────────────────────────────────────────
  function startOutbound(peer, name) {
    if (current) { box.style.display = 'block'; return; }
    current = { callId: null, name: name || peer, peer: peer, direction: 'outbound' };
    getMic().then(function (stream) {
      localStream = stream; newPc();
      stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
        .then(waitIceComplete)
        .then(function () { sendWs({ type: 'callback', to: peer, offerSdp: pc.localDescription.sdp }); showCalling(current); });
    }).catch(function (err) { micError(err); endLocal(); });
  }

  function decline() { if (current && current.callId) sendWs({ type: 'reject', callId: current.callId }); endLocal(); }
  function hangup() { if (current && current.callId) sendWs({ type: 'hangup', callId: current.callId }); endLocal(); }
  function toggleMute() {
    if (!localStream) return;
    var btn = box.querySelector('.wp-mute'); var on = btn.classList.toggle('on');
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !on; });
    btn.textContent = on ? 'Unmute' : 'Mute';
  }
  function cleanupMedia() {
    try { if (pc) pc.close(); } catch (e) {} pc = null;
    if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
    if (remoteAudio) { try { remoteAudio.srcObject = null; } catch (e) {} }
  }
  function endLocal() { stopRing(); cleanupMedia(); current = null; connectedAt = 0; hide(); }

  // ── signalling ─────────────────────────────────────────────────────────────────
  function sendWs(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  function onMessage(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'incoming') {
      if (current) { sendWs({ type: 'reject', callId: m.callId }); return; }
      current = { callId: m.callId, name: m.name || m.from, peer: m.from, offerSdp: m.offerSdp, direction: 'inbound' };
      showIncoming(current); startRing();
    } else if (m.type === 'calling') {                 // our outbound call got a call_id
      if (current && current.direction === 'outbound') { current.callId = m.callId; if (m.name) current.name = m.name; }
    } else if (m.type === 'answer') {                  // customer answered our outbound call
      if (current && current.callId === m.callId && pc) {
        stopRing();
        pc.setRemoteDescription({ type: 'answer', sdp: m.answerSdp }).then(function () { showInCall(current); }).catch(function () {});
      }
    } else if (m.type === 'taken') {
      if (current && current.callId === m.callId && !pc) endLocal();
    } else if (m.type === 'accepted') {
      if (current && current.callId === m.callId) showInCall(current);
    } else if (m.type === 'ended') {
      if (current && current.callId === m.callId) endLocal();
    } else if (m.type === 'error') {
      alert('Call: ' + (m.message || 'error')); endLocal();
    } else if (m.type === 'chat') {
      chatAlert(m);
    } else if (m.type === 'chat-taken') {
      dismissChat(m.sessionId);
    } else if (m.type === 'alert') {
      netAlert(m);
    } else if (m.type === 'wa') {
      waAlert(m);
    }
  }

  // Louder triple-chime + green pop-up for an inbound WhatsApp message, so it's not missed.
  function waChime() {
    try {
      var c = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.2, 0.4].forEach(function (off) {
        var o = c.createOscillator(), g = c.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(c.destination);
        g.gain.setValueAtTime(0.0001, c.currentTime + off);
        g.gain.exponentialRampToValueAtTime(0.4, c.currentTime + off + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + off + 0.18);
        o.start(c.currentTime + off); o.stop(c.currentTime + off + 0.2);
      });
      setTimeout(function () { try { c.close(); } catch (e) {} }, 1300);
    } catch (e) {}
  }
  function waAlert(m) {
    try { var b = document.getElementById('navChatBadge'); if (b) { var n = (parseInt(b.textContent || '0', 10) || 0) + 1; b.textContent = n; b.style.background = '#22c55e'; b.style.display = 'inline-flex'; } } catch (e) {}
    waChime();
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;right:24px;top:80px;z-index:2147483600;width:340px;background:#0f172a;color:#fff;border-radius:14px;box-shadow:0 14px 40px rgba(2,6,23,.5);border:1px solid #1e293b;border-left:5px solid #22c55e;padding:14px 16px;cursor:pointer;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
    var who = m.name || m.waNum || 'Message';
    var label = m.channelLabel || 'WhatsApp';
    var chan = (label.toLowerCase() === 'teams') ? 'teams' : 'whatsapp';
    var msg = m.body ? ('<div style="font-size:13px;color:#e2e8f0;margin-top:8px;white-space:pre-wrap;max-height:96px;overflow:auto;background:#111c30;border-radius:8px;padding:8px 10px;">' + esc(m.body) + '</div>') : '';
    t.innerHTML = '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">🟢 ' + esc(label) + ' message</div><div style="font-size:13px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(who) + '</div>' + msg;
    t.onclick = function () { location.href = m.ticketId ? '/tickets/' + m.ticketId : '/chat/channel/' + chan; };
    document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 60000);
  }

  // Loud repeating two-tone siren for site-down / critical alerts.
  function siren() {
    try {
      var c = new (window.AudioContext || window.webkitAudioContext)();
      var g = c.createGain(); g.connect(c.destination); g.gain.value = 0.35;
      var o = c.createOscillator(); o.type = 'sawtooth'; o.connect(g); o.start();
      var t0 = c.currentTime, dur = 4, step = 0.45;
      for (var i = 0; i < dur / step; i++) o.frequency.setValueAtTime(i % 2 ? 920 : 560, t0 + i * step);
      o.stop(t0 + dur);
      setTimeout(function () { try { c.close(); } catch (e) {} }, (dur + 0.3) * 1000);
    } catch (e) {}
  }
  // Real-time N3twrx network/comms alert toast for staff.
  function netAlert(m) {
    try { if (window.__n3Refresh) window.__n3Refresh(); } catch (e) {}   // bump the nav badge instantly
    if (m.severity === 'critical') siren(); else chatBeep();
    var col = m.severity === 'critical' ? '#ef4444' : (m.severity === 'info' ? '#2563eb' : '#f59e0b');
    var src = m.source === 'giacom' ? 'Giacom' : (m.source === 'unifi' ? 'UniFi' : 'Network');
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;right:24px;top:92px;z-index:2147483600;width:320px;background:#0f172a;color:#fff;border-radius:14px;box-shadow:0 14px 40px rgba(2,6,23,.5);border:1px solid #1e293b;border-left:5px solid ' + col + ';padding:14px 16px;cursor:pointer;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
    t.innerHTML = '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">⚠️ ' + src + ' alert</div>';
    var label = document.createElement('div');
    label.style.cssText = 'font-size:13px;color:#cbd5e1;';
    label.textContent = m.title || 'Network alert';
    t.appendChild(label);
    t.onclick = function () { location.href = m.ticketId ? '/tickets/' + m.ticketId : '/n3twrx'; };
    document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, m.severity === 'critical' ? 120000 : 30000);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // Flash the "Chat" nav item red while any website chat is unclaimed.
  function navChatFlash() {
    var nav = document.getElementById('navChat');
    var badge = document.getElementById('navChatBadge');
    var n = Object.keys(pendingChats).length;
    if (nav) { if (n > 0) nav.classList.add('chat-flash'); else nav.classList.remove('chat-flash'); }
    if (badge) { badge.textContent = n; badge.style.display = n > 0 ? '' : 'none'; }
  }

  function dismissChat(id) {
    var t = chatToasts[id]; if (t) { try { t.remove(); } catch (e) {} delete chatToasts[id]; }
    if (pendingChats[id]) { delete pendingChats[id]; navChatFlash(); }
  }

  // Real-time "new website chat" pop-up for ALL staff — shows the visitor's message and a
  // "Take ownership" button. Idempotent per session (a later message updates the same card)
  // and stays on screen until claimed or dismissed.
  function chatAlert(m) {
    var existing = chatToasts[m.sessionId];
    if (!pendingChats[m.sessionId]) { pendingChats[m.sessionId] = true; navChatFlash(); }
    chatBeep();
    var t = existing || document.createElement('div');
    t.style.cssText = 'position:fixed;right:24px;top:24px;z-index:2147483600;width:320px;background:#0f172a;color:#fff;border-radius:14px;box-shadow:0 14px 40px rgba(2,6,23,.5);border:1px solid #1e293b;padding:14px 16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
    var who = (m.name || 'Website visitor') + (m.department ? ' · ' + m.department : '');
    var msg = m.body ? ('<div style="font-size:13px;color:#e2e8f0;margin-top:8px;white-space:pre-wrap;max-height:96px;overflow:auto;background:#111c30;border-radius:8px;padding:8px 10px;">' + esc(m.body) + '</div>') : '';
    t.innerHTML =
      '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">💬 New website chat</div>' +
      '<div style="font-size:13px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(who) + '</div>' +
      msg +
      '<div style="display:flex;gap:8px;margin-top:12px;">' +
        '<button data-take style="flex:1;background:#22c55e;border:none;color:#06251a;border-radius:8px;padding:9px 12px;font-weight:700;cursor:pointer;">Take ownership</button>' +
        '<button data-x style="background:#1e293b;border:none;color:#94a3b8;border-radius:8px;padding:9px 12px;cursor:pointer;">Dismiss</button>' +
      '</div>';
    t.querySelector('[data-take]').onclick = function (e) {
      e.stopPropagation();
      fetch('/chat/' + m.sessionId + '/claim', { method: 'POST' })
        .then(function () { location.href = '/chat/' + m.sessionId; })
        .catch(function () { location.href = '/chat/' + m.sessionId; });
    };
    t.querySelector('[data-x]').onclick = function (e) { e.stopPropagation(); dismissChat(m.sessionId); };
    if (!existing) { document.body.appendChild(t); chatToasts[m.sessionId] = t; }
  }

  // On load, light up the nav for any chats that are already waiting and unclaimed.
  function initChatFlash() {
    fetch('/chat/list.json').then(function (r) { return r.json(); }).then(function (rows) {
      (rows || []).forEach(function (s) { if (s && !s.assigned_user_id && s.status !== 'closed') pendingChats[s.id] = true; });
      navChatFlash();
    }).catch(function () {});
  }
  function chatBeep() {
    try {
      var c = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach(function (off) {
        var o = c.createOscillator(), g = c.createGain();
        o.frequency.value = 660; o.connect(g); g.connect(c.destination);
        g.gain.setValueAtTime(0.0001, c.currentTime + off);
        g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + off + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + off + 0.15);
        o.start(c.currentTime + off); o.stop(c.currentTime + off + 0.16);
      });
      setTimeout(function () { try { c.close(); } catch (e) {} }, 700);
    } catch (e) {}
  }

  function connect() {
    initChatFlash();
    fetch('/api/calls/ice').then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.iceServers && d.iceServers.length) iceServers = d.iceServers; })
      .catch(function () {}).finally(openWs);
  }
  function openWs() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(proto + '://' + location.host + '/ws/calls'); } catch (e) { scheduleReconnect(); return; }
    ws.onmessage = onMessage;
    ws.onclose = scheduleReconnect;
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    setInterval(function () { sendWs({ type: 'ping' }); }, 25000);
  }
  function scheduleReconnect() { if (reconnectTimer) return; reconnectTimer = setTimeout(function () { reconnectTimer = null; openWs(); }, 4000); }

  // Exposed so the Soft Phone page (and anywhere else) can start a call-back via the widget.
  window.waPhoneCall = function (peer, name) { startOutbound(peer, name); };

  connect();
})();
