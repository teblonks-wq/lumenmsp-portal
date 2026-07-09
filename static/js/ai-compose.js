/* AI compose helper — dictate with the browser's speech recognition, then "Polish with Claude"
   turns the rough text into a ready-to-send message via /ai/compose. Reusable across composers.
   Usage:
     AiCompose.attach({ quill, micBtn, polishBtn, statusEl, getRecipient, getChannel });
*/
(function () {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }
  // Plain text (with blank-line paragraphs) -> simple HTML for the Quill editor.
  function toHtml(text) {
    // Each blank-line-separated block becomes a paragraph; a spacer paragraph is inserted between
    // them so there is clear spacing between sentences/paragraphs for easy reading.
    var paras = String(text || '').trim().split(/\n\s*\n/).filter(function (p) { return p.trim(); }).map(function (p) {
      return '<p>' + escapeHtml(p.trim()).replace(/\n/g, '<br>') + '</p>';
    });
    return paras.join('<p><br></p>');
  }

  function attach(opts) {
    var quill = opts.quill, mic = opts.micBtn, polish = opts.polishBtn, statusEl = opts.statusEl;
    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.style.color = kind === 'err' ? '#b91c1c' : (kind === 'ok' ? '#166534' : '#64748b');
    }

    // ── Dictation (Web Speech API) ──
    var rec = null, listening = false;
    if (mic) {
      if (!SR) {
        mic.disabled = true;
        mic.title = 'Voice input is not supported in this browser — type your notes and use Polish.';
      } else {
        mic.addEventListener('click', function () {
          if (listening) { try { rec.stop(); } catch (e) {} return; }
          rec = new SR();
          rec.lang = 'en-GB';
          rec.interimResults = false;
          rec.continuous = true;
          rec.onstart = function () { listening = true; mic.classList.add('rec'); mic.innerHTML = '■ Stop'; setStatus('Listening… speak your message, then Stop.'); };
          rec.onerror = function (e) { setStatus('Mic error: ' + (e.error || 'unknown'), 'err'); };
          rec.onend = function () { listening = false; mic.classList.remove('rec'); mic.innerHTML = '🎤 Dictate'; if (statusEl && statusEl.textContent.indexOf('Listening') === 0) setStatus(''); };
          rec.onresult = function (ev) {
            var txt = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) { if (ev.results[i].isFinal) txt += ev.results[i][0].transcript; }
            if (txt) {
              var sel = quill.getLength();
              quill.insertText(sel > 0 ? sel - 1 : 0, (sel > 1 ? ' ' : '') + txt.trim());
            }
          };
          try { rec.start(); } catch (e) { setStatus('Could not start the mic.', 'err'); }
        });
      }
    }

    // ── Polish with Claude ──
    if (polish) {
      polish.addEventListener('click', function () {
        var transcript = quill.getText().trim();
        if (!transcript) { setStatus('Type or dictate something first.', 'err'); return; }
        var orig = polish.innerHTML;
        polish.disabled = true; polish.innerHTML = '✨ Polishing…';
        setStatus('Claude is composing your message…');
        fetch('/ai/compose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: transcript,
            recipient: opts.getRecipient ? opts.getRecipient() : null,
            channel: opts.getChannel ? opts.getChannel() : null,
          }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.ok && d.message) {
            quill.root.innerHTML = toHtml(d.message);
            setStatus('Polished — review and send.', 'ok');
          } else {
            setStatus((d && d.error) || 'Compose failed.', 'err');
          }
        }).catch(function () {
          setStatus('Compose failed — network error.', 'err');
        }).finally(function () {
          polish.disabled = false; polish.innerHTML = orig;
        });
      });
    }

    // ── Claude Update (context-aware: polishes the draft using the whole ticket thread) ──
    var update = opts.updateBtn;
    if (update) {
      update.addEventListener('click', function () {
        var draft = quill.getText().trim();
        if (!draft) { setStatus('Type or dictate your update first.', 'err'); return; }
        if (!opts.ticketId) { setStatus('No ticket reference — use Polish instead.', 'err'); return; }
        var orig = update.innerHTML;
        update.disabled = true; update.innerHTML = '🧠 Reviewing…';
        setStatus('Claude is reviewing the ticket and polishing your update…');
        fetch('/ai/ticket-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ticketId: opts.ticketId,
            draft: draft,
            recipient: opts.getRecipient ? opts.getRecipient() : null,
            channel: opts.getChannel ? opts.getChannel() : null,
          }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.ok && d.message) {
            quill.root.innerHTML = toHtml(d.message);
            setStatus('Updated with ticket context — review and send.', 'ok');
          } else {
            setStatus((d && d.error) || 'Claude Update failed.', 'err');
          }
        }).catch(function () {
          setStatus('Claude Update failed — network error.', 'err');
        }).finally(function () {
          update.disabled = false; update.innerHTML = orig;
        });
      });
    }
  }

  window.AiCompose = { attach: attach, supported: !!SR };
})();
