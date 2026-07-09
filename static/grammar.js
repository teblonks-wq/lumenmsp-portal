// Reusable spell + grammar checker for Quill editors, backed by the portal's
// /tools/grammar.json proxy to a self-hosted LanguageTool server.
//
//   LumenGrammar.attach(quill, anchorEl)
//
// Upgrades over the old button-only checker:
//   • live checking — re-checks ~1.4s after you stop typing (and on demand)
//   • inline underlines drawn in a non-destructive overlay (spelling=red,
//     grammar=amber, style=blue) — never written into the message HTML
//   • results list with one-click "apply suggestion"
//   • issue count on the button; quiet when the service isn't configured
window.LumenGrammar = (function () {
  function esc(s) { return (s || '').replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }
  function escAttr(s) { return (s || '').replace(/"/g, '&quot;'); }

  // Colour an issue by LanguageTool category / issue type.
  function colourFor(m) {
    var t = (m.rule && (m.rule.issueType || (m.rule.category && m.rule.category.id))) || '';
    t = String(t).toLowerCase();
    if (t.indexOf('misspell') >= 0 || t.indexOf('typo') >= 0) return '#dc2626'; // red — spelling
    if (t.indexOf('style') >= 0 || t.indexOf('redundan') >= 0) return '#2563eb'; // blue — style
    return '#d97706'; // amber — grammar / everything else
  }

  function attach(quill, anchorEl) {
    if (!quill || !anchorEl) return;
    // We draw our own underlines; turn the browser's red squiggle off to avoid doubling up.
    try { quill.root.setAttribute('spellcheck', 'false'); } catch (e) {}

    // Toolbar row
    var bar = document.createElement('div');
    bar.style.cssText = 'margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Check spelling & grammar';
    var status = document.createElement('span');
    status.className = 'muted'; status.style.cssText = 'font-size:12px;';
    bar.appendChild(btn);

    // Improve with Claude — polish the draft into clear, professional British English. Appears on
    // every rich composer this grammar checker is attached to (tickets, mail, entity comms, …).
    var aiBtn = document.createElement('button');
    aiBtn.type = 'button'; aiBtn.className = 'btn';
    aiBtn.innerHTML = '✨ Improve with Claude';
    bar.appendChild(aiBtn);
    bar.appendChild(status);
    function aiToHtml(t) {
      var e = function (s) { return String(s || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
      var ps = String(t || '').trim().split(/\n\s*\n/).filter(function (p) { return p.trim(); })
        .map(function (p) { return '<p>' + e(p.trim()).replace(/\n/g, '<br>') + '</p>'; });
      return ps.join('') || '<p><br></p>';
    }
    function aiCsrf() { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : ''; }
    aiBtn.addEventListener('click', function () {
      var text = quill.getText().trim();
      if (!text) { status.textContent = 'Type something first.'; status.style.color = '#b91c1c'; return; }
      var orig = aiBtn.innerHTML; aiBtn.disabled = true; aiBtn.innerHTML = '✨ Improving…';
      status.textContent = 'Claude is improving your text…'; status.style.color = '#64748b';
      fetch('/ai/polish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': aiCsrf() }, body: JSON.stringify({ text: text }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.ok && d.message) { quill.root.innerHTML = aiToHtml(d.message); status.textContent = 'Improved — review before sending.'; status.style.color = '#166534'; }
          else { status.textContent = (d && d.error) || 'Improve failed.'; status.style.color = '#b91c1c'; }
        }).catch(function () { status.textContent = 'Improve failed — network error.'; status.style.color = '#b91c1c'; })
        .finally(function () { aiBtn.disabled = false; aiBtn.innerHTML = orig; });
    });

    var res = document.createElement('div');
    res.style.cssText = 'margin-top:6px;';
    anchorEl.appendChild(bar);
    anchorEl.appendChild(res);

    // Non-destructive underline overlay, sitting over the editor content.
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden;';
    try {
      var host = quill.container; // .ql-container (already position:relative in the snow theme)
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(overlay);
    } catch (e) { overlay = null; }

    var cache = [];

    function clearMarks() { if (overlay) overlay.innerHTML = ''; }

    function drawMarks(matches) {
      if (!overlay) return;
      try {
        overlay.innerHTML = '';
        var scrollTop = quill.root.scrollTop || 0;
        matches.forEach(function (m) {
          var b = quill.getBounds(m.offset, m.length);
          if (!b || !b.width) return;
          var mark = document.createElement('div');
          mark.style.cssText = 'position:absolute;pointer-events:none;height:0;border-bottom:2px solid ' + colourFor(m)
            + ';left:' + b.left + 'px;top:' + (b.top + b.height - 2 - scrollTop) + 'px;width:' + b.width + 'px;';
          overlay.appendChild(mark);
        });
      } catch (e) { /* positioning is best-effort; the list below is the reliable path */ }
    }

    function render(matches) {
      cache = matches;
      var text = quill.getText();
      if (!matches.length) { res.innerHTML = ''; status.textContent = 'No issues found.'; clearMarks(); return; }
      status.textContent = matches.length + ' issue' + (matches.length === 1 ? '' : 's');
      btn.textContent = 'Re-check (' + matches.length + ')';
      res.innerHTML = matches.slice(0, 30).map(function (m, i) {
        var bad = text.substr(m.offset, m.length);
        var sugg = (m.replacements || []).slice(0, 5).map(function (s) { return s.value; });
        return '<div style="border:1px solid var(--line);border-left:3px solid ' + colourFor(m) + ';border-radius:6px;padding:6px 9px;margin-bottom:4px;font-size:13px;">'
          + '<strong>' + esc(bad) + '</strong> — ' + esc(m.message)
          + (sugg.length ? '<br><span class="muted">Fix:</span> ' + sugg.map(function (s) {
            return '<a href="#" class="lg-fix" data-off="' + m.offset + '" data-len="' + m.length + '" data-rep="' + escAttr(s) + '">' + esc(s) + '</a>';
          }).join(' &middot; ') : '')
          + '</div>';
      }).join('');
      res.querySelectorAll('.lg-fix').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var off = +a.getAttribute('data-off'), len = +a.getAttribute('data-len'), rep = a.getAttribute('data-rep');
          quill.deleteText(off, len);
          quill.insertText(off, rep);
          run();
        });
      });
      drawMarks(matches);
    }

    var inflight = 0;
    function run() {
      var text = quill.getText();
      if (!text.trim()) { render([]); status.textContent = ''; return; }
      var seq = ++inflight;
      status.textContent = 'Checking…';
      fetch('/tools/grammar.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (seq !== inflight) return; // ignore stale responses
          btn.textContent = 'Check spelling & grammar';
          if (d && d.error === 'unavailable') { status.textContent = 'Grammar service unreachable.'; return; }
          render((d && d.matches) || []);
        })
        .catch(function () { if (seq === inflight) status.textContent = 'Checker unavailable.'; });
    }

    // Live: re-check shortly after typing stops; clear stale underlines immediately on edit.
    var timer;
    quill.on('text-change', function (_delta, _old, source) {
      if (source !== 'user') return;
      clearMarks();
      clearTimeout(timer);
      timer = setTimeout(run, 1400);
    });
    quill.root.addEventListener('scroll', function () { drawMarks(cache); });
    btn.addEventListener('click', run);
  }

  return { attach: attach };
})();
