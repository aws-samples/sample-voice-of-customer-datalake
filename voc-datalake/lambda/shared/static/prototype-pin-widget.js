/*
 * VoC prototype pin widget (todofeatures §6.2) — injected into generated
 * prototype HTML by shared/prototype_pins.py::inject_pin_widget.
 *
 * Self-contained, no third-party code, no network: the prototype CSP has no
 * connect-src, so a pin is handed to the HOST FRAME (the VoC prototype viewer)
 * with postMessage, and the host submits it through the public
 * POST /feedback-forms/{form_id}/submit route. Opened standalone (no parent)
 * the widget says where to open the prototype instead.
 *
 * Messages (same origin only, both directions):
 *   widget → host  {source:'voc-pin-widget', type:'submit', formId, requestId, body}
 *                  {source:'voc-pin-widget', type:'ready', formId, review}
 *   host → widget  {source:'voc-pin-host', type:'result', requestId, ok}
 *                  {source:'voc-pin-host', type:'show', pins:[{pin_id, number, selector, bbox, status}]}
 *                  {source:'voc-pin-host', type:'hide'}
 *
 * Console errors and unhandled rejections are captured by this widget's own
 * listener (last 20, each ≤500 chars) and redacted here AND on the server.
 */
(function () {
  'use strict';

  var MAX_CONSOLE = 20;
  var MAX_CONSOLE_CHARS = 500;
  var MAX_SNIPPET = 200;
  var MAX_SELECTOR = 512;
  var MAX_COMMENT = 2000;
  var MAX_ROUTE = 300;
  var MAX_UA = 300;
  var MAX_DEPTH = 6;
  var PREFIX = 'voc-pin-';

  // ---- Redaction (mirrors shared/prototype_pins.py::redact) -----------------
  function redact(text) {
    var out = String(text == null ? '' : text);
    out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
    out = out.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]');
    out = out.replace(/\bbearer\s+[^\s&,;]+/gi, 'Bearer [redacted]');
    out = out.replace(
      /\b(token|access_token|id_token|api[_-]?key|key|secret|password|passwd|signature|sig)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1=[redacted]');
    out = out.replace(/[A-Za-z0-9_\-+/=]{24,}/g, function (m) {
      return (/\d/.test(m) && /[A-Za-z]/.test(m)) ? '[token]' : m;
    });
    return out.replace(/\d(?:[\s-]?\d){4,}/g, '[number]');
  }

  function clip(text, limit) {
    var s = String(text == null ? '' : text);
    return s.length > limit ? s.slice(0, limit) : s;
  }

  // ---- Console capture -------------------------------------------------------
  var consoleLog = [];
  function record(level, parts) {
    var message = '';
    for (var i = 0; i < parts.length; i += 1) {
      var p = parts[i];
      var piece;
      if (p && p.message) piece = p.name ? p.name + ': ' + p.message : p.message;
      else if (typeof p === 'string') piece = p;
      else { try { piece = JSON.stringify(p); } catch (e) { piece = String(p); } }
      message += (i ? ' ' : '') + clip(piece, MAX_CONSOLE_CHARS * 2);
    }
    message = clip(redact(message.trim()), MAX_CONSOLE_CHARS);
    if (!message) return;
    consoleLog.push({ level: level, message: message });
    if (consoleLog.length > MAX_CONSOLE) consoleLog.splice(0, consoleLog.length - MAX_CONSOLE);
  }

  function installConsoleCapture(win) {
    var original = win.console && win.console.error;
    if (original && !original.__vocPin) {
      var wrapped = function () {
        record('error', Array.prototype.slice.call(arguments));
        return original.apply(this, arguments);
      };
      wrapped.__vocPin = true;
      win.console.error = wrapped;
    }
    win.addEventListener('error', function (e) {
      if (e && e.target && e.target !== win) return; // resource load errors
      record('error', [e && (e.error || e.message) || 'Script error']);
    });
    win.addEventListener('unhandledrejection', function (e) {
      record('rejection', [e && e.reason !== undefined ? e.reason : 'Unhandled rejection']);
    });
  }

  // ---- Stable selector ---------------------------------------------------------
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, function (c) { return '\\' + c; });
  }

  function isOwn(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && n.id.indexOf(PREFIX) === 0) return true;
    }
    return false;
  }

  function uniqueId(el, doc) {
    if (!el.id || el.id.indexOf(PREFIX) === 0) return '';
    var sel = '#' + cssEscape(el.id);
    try { return doc.querySelectorAll(sel).length === 1 ? sel : ''; } catch (e) { return ''; }
  }

  function segment(el) {
    var tag = el.tagName.toLowerCase();
    var parent = el.parentElement;
    if (!parent) return tag;
    var index = 0;
    var count = 0;
    for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === el.tagName) {
        count += 1;
        if (c === el) index = count;
      }
    }
    return count > 1 ? tag + ':nth-of-type(' + index + ')' : tag;
  }

  function buildSelector(target, doc) {
    var d = doc || document;
    if (!target || target.nodeType !== 1) return '';
    var parts = [];
    for (var n = target, depth = 0; n && n.nodeType === 1 && depth < MAX_DEPTH; n = n.parentElement, depth += 1) {
      var id = uniqueId(n, d);
      if (id) { parts.unshift(id); break; }
      if (n === d.body || n === d.documentElement) { parts.unshift(n.tagName.toLowerCase()); break; }
      parts.unshift(segment(n));
    }
    return clip(parts.join(' > '), MAX_SELECTOR);
  }

  // ---- Payload -------------------------------------------------------------------
  function pct(value, total) {
    if (!total) return 0;
    var p = (value / total) * 100;
    return Math.round(Math.min(Math.max(p, 0), 100) * 100) / 100;
  }

  function currentRoute(loc) {
    // Path + hash only: a signed prototype URL carries its credentials in the query.
    var path = loc && loc.pathname ? loc.pathname.split('/').pop() : '';
    return clip(redact(path + (loc && loc.hash ? loc.hash : '')), MAX_ROUTE);
  }

  function buildPayload(target, comment, win) {
    var w = win || window;
    var rect = target.getBoundingClientRect();
    var vw = w.innerWidth || 0;
    var vh = w.innerHeight || 0;
    return {
      text: clip(String(comment || '').trim(), MAX_COMMENT),
      pin: {
        selector: buildSelector(target, w.document),
        text_snippet: clip(redact((target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim()), MAX_SNIPPET),
        bbox: { x: pct(rect.left, vw), y: pct(rect.top, vh), w: pct(rect.width, vw), h: pct(rect.height, vh) },
        viewport: { w: Math.round(vw), h: Math.round(vh) },
        scroll: { x: Math.round(w.scrollX || 0), y: Math.round(w.scrollY || 0) },
        route: currentRoute(w.location),
        user_agent: clip(w.navigator ? w.navigator.userAgent : '', MAX_UA),
        console: consoleLog.slice(-MAX_CONSOLE)
      }
    };
  }

  // ---- UI ------------------------------------------------------------------------------
  var state = { formId: '', seq: 0, pending: {}, markers: [] };

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    if (text) node.textContent = text;
    return node;
  }

  var BASE = 'font:14px/1.4 system-ui,-apple-system,sans-serif;box-sizing:border-box;';
  var BUTTON = BASE + 'position:fixed;right:16px;bottom:16px;z-index:2147483646;padding:10px 16px;' +
    'border:0;border-radius:999px;background:#1f2937;color:#fff;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);';
  var SECONDARY = BASE + 'padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;';
  var PRIMARY = BASE + 'padding:6px 12px;border:0;border-radius:8px;background:#1f2937;color:#fff;cursor:pointer;';
  var PANEL = BASE + 'position:fixed;right:16px;bottom:64px;z-index:2147483647;width:300px;max-width:calc(100vw - 32px);' +
    'padding:12px;border-radius:12px;background:#fff;color:#111827;box-shadow:0 8px 24px rgba(0,0,0,.25);';

  function hasParentFrame() {
    try { return window.parent && window.parent !== window; } catch (e) { return false; }
  }

  function closePanel() {
    var panel = document.getElementById(PREFIX + 'panel');
    if (panel) panel.parentNode.removeChild(panel);
    clearHighlight();
  }

  function showPanel(children) {
    closePanel();
    var panel = el('div', { id: PREFIX + 'panel', role: 'dialog', 'aria-label': 'Prototype feedback', style: PANEL });
    for (var i = 0; i < children.length; i += 1) panel.appendChild(children[i]);
    document.body.appendChild(panel);
    return panel;
  }

  function notice(text) {
    var panel = showPanel([el('p', { style: 'margin:0 0 8px;' }, text)]);
    var ok = el('button', { type: 'button', style: SECONDARY }, 'Close');
    ok.addEventListener('click', closePanel);
    panel.appendChild(ok);
  }

  var highlight = null;
  function clearHighlight() {
    if (highlight && highlight.parentNode) highlight.parentNode.removeChild(highlight);
    highlight = null;
  }

  function outline(target) {
    clearHighlight();
    var r = target.getBoundingClientRect();
    highlight = el('div', { id: PREFIX + 'highlight', style: 'position:fixed;pointer-events:none;z-index:2147483645;' +
      'border:2px solid #f59e0b;border-radius:4px;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' });
    document.body.appendChild(highlight);
  }

  function send(body) {
    state.seq += 1;
    var requestId = 'r' + state.seq;
    state.pending[requestId] = true;
    window.parent.postMessage({ source: 'voc-pin-widget', type: 'submit', formId: state.formId, requestId: requestId, body: body },
      window.location.origin);
    return requestId;
  }

  function composer(target) {
    var area = el('textarea', { id: PREFIX + 'comment', rows: '4', maxlength: String(MAX_COMMENT),
      'aria-label': 'Your comment', placeholder: 'What should change here?',
      style: BASE + 'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;resize:vertical;' });
    var row = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;' });
    var cancel = el('button', { type: 'button', style: SECONDARY }, 'Cancel');
    var submit = el('button', { type: 'button', style: PRIMARY }, 'Send');
    cancel.addEventListener('click', closePanel);
    submit.addEventListener('click', function () {
      var text = area.value.trim();
      if (!text) { area.focus(); return; }
      submit.disabled = true;
      send(buildPayload(target, text, window));
    });
    row.appendChild(cancel);
    row.appendChild(submit);
    showPanel([el('p', { style: 'margin:0 0 8px;font-weight:600;' }, 'Comment on this element'), area, row]);
    outline(target);
    area.focus();
  }

  function stopPicking() {
    document.documentElement.style.cursor = '';
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onPick(e) {
    var target = e.target;
    if (!target || target.nodeType !== 1 || isOwn(target)) return;
    e.preventDefault();
    e.stopPropagation();
    stopPicking();
    composer(target);
  }

  function onKey(e) {
    if (e.key === 'Escape') { stopPicking(); closePanel(); }
  }

  function startPicking() {
    if (!hasParentFrame()) {
      notice('Open this prototype from the VoC app (Projects → Documents) to leave feedback.');
      return;
    }
    closePanel();
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onKey, true);
    notice('Click the element you want to comment on. Press Esc to cancel.');
  }

  // ---- Review markers --------------------------------------------------------------------
  function clearMarkers() {
    for (var i = 0; i < state.markers.length; i += 1) {
      var m = state.markers[i];
      if (m.parentNode) m.parentNode.removeChild(m);
    }
    state.markers = [];
  }

  function markerPosition(pin) {
    var target = null;
    try { target = pin.selector ? document.querySelector(pin.selector) : null; } catch (e) { target = null; }
    if (target) {
      var r = target.getBoundingClientRect();
      return { left: r.left + window.scrollX, top: r.top + window.scrollY };
    }
    // Selector drift: fall back to the recorded position.
    var b = pin.bbox || {};
    return { left: (Number(b.x) || 0) / 100 * window.innerWidth, top: (Number(b.y) || 0) / 100 * window.innerHeight };
  }

  function showMarkers(pins) {
    clearMarkers();
    if (!pins || !pins.length) return;
    for (var i = 0; i < pins.length && i < 200; i += 1) {
      var pin = pins[i] || {};
      var pos = markerPosition(pin);
      var colour = pin.status === 'resolved' ? '#16a34a' : (pin.status === 'addressed' ? '#2563eb' : '#f59e0b');
      var marker = el('div', { id: PREFIX + 'marker-' + i, title: 'Pin ' + (pin.number || i + 1),
        style: BASE + 'position:absolute;z-index:2147483644;left:' + Math.max(pos.left - 10, 0) + 'px;top:' + Math.max(pos.top - 10, 0) + 'px;' +
          'width:22px;height:22px;border-radius:50%;background:' + colour + ';color:#fff;font-size:12px;font-weight:700;' +
          'display:flex;align-items:center;justify-content:center;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.4);' },
        String(pin.number || i + 1));
      document.body.appendChild(marker);
      state.markers.push(marker);
    }
  }

  function onMessage(e) {
    if (e.origin !== window.location.origin || e.source !== window.parent) return;
    var data = e.data;
    if (!data || data.source !== 'voc-pin-host') return;
    if (data.type === 'result' && state.pending[data.requestId]) {
      delete state.pending[data.requestId];
      notice(data.ok ? 'Thanks — your pin was saved.' : 'Your pin could not be saved. Please try again.');
    } else if (data.type === 'show') {
      showMarkers(data.pins);
    } else if (data.type === 'hide') {
      clearMarkers();
    }
  }

  function init(options) {
    var formId = options && options.formId;
    if (!/^pf_[0-9a-f]{16}$/.test(String(formId || '')) || state.formId) return;
    state.formId = formId;
    installConsoleCapture(window);
    window.addEventListener('message', onMessage);
    var mount = function () {
      if (document.getElementById(PREFIX + 'button')) return;
      var button = el('button', { id: PREFIX + 'button', type: 'button', 'aria-label': 'Leave feedback on this prototype', style: BUTTON }, 'Feedback');
      button.addEventListener('click', startPicking);
      document.body.appendChild(button);
      if (hasParentFrame()) {
        var review = /(?:^|[?&#])review=1(?:&|$)/.test(window.location.search + '&' + window.location.hash);
        window.parent.postMessage({ source: 'voc-pin-widget', type: 'ready', formId: formId, review: review }, window.location.origin);
      }
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }

  window.VoCPinWidget = Object.freeze({
    init: init,
    redact: redact,
    clip: clip,
    buildSelector: buildSelector,
    buildPayload: buildPayload,
    currentRoute: currentRoute,
    record: record,
    consoleEntries: function () { return consoleLog.slice(); }
  });
})();
