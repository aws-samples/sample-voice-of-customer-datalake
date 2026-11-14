/*
 * VoC prototype walkthrough (docs/prototype-builder.md, Part 1: guided demo, skippable) — injected into a
 * prototype version's HTML by the server, between the two voc-walkthrough HTML comments: first a script element
 * of type application/json with the id voc-walkthrough-steps holding {"steps":[…]}, then a script element holding
 * this file and a call of window.VoCWalkthrough.init(). (This file never spells out an HTML comment opener or
 * a script end tag: it is inlined into a script element, and the server refuses a runtime that does.)
 * A step: {title (1..80), body (1..280, plain text), selector? (≤ 512), anchor? {route (≤ 300), bbox {x, y, w, h}
 * as shares 0..1 of the viewport}}, at least one of selector / anchor; 1..10 steps. The server validated them;
 * this file checks them again and drops what is not a step (the block is data, never run).
 *
 * Self-contained, no third-party code; every text is set with textContent.
 *
 * Where it runs.
 *  - STANDALONE (no parent frame): it starts on every load. The sandbox gives the page an opaque origin and no
 *    storage, so "Don't show again" lasts for this page load only, and the popup says so.
 *  - FRAMED (the VoC app's preview): it waits for the host. Like the pin widget, it hands the host a private
 *    MessageChannel port with a ready message and listens on that port only (the host cannot address an opaque
 *    window by origin). Messages (every one from the frame is untrusted on the host's side):
 *      frame → host  {type:'voc-walkthrough', event:'ready', steps: <count>}            (the handshake, with the port)
 *                    {type:'voc-walkthrough', event:'done'|'skipped'|'dont-show-again'}
 *                    {type:'voc-walkthrough', event:'picked', selector?, anchor}       (the editor's element picker)
 *                    {type:'voc-walkthrough', event:'pick-cancelled'}
 *      host → frame  {type:'voc-walkthrough', action:'start', step?, steps?}  (steps: the editor's unsaved steps, a preview)
 *                    {type:'voc-walkthrough', action:'pick'}
 *    The picker is this file's own (the pin widget's opens its comment panel and lives in the widget's closure); it
 *    records the pin widget's stable selector for the element (window.VoCPinWidget.buildSelector; without the widget,
 *    none) and the element's position, as shares 0..1.
 *    The steps are read from the server's block, the element right before this file's script (else the last one).
 *
 * The popup: a non-modal role="dialog" named by the step's title, its body as the description; focus moves to
 * it when it opens and back to where it was when it closes; Tab goes Back, Next, Skip, Don't show again;
 * Left / Right are Back / Next; Esc skips; each step is announced in a polite live region. The anchored element
 * gets a thick outline with a dashed ring (not colour alone). Below 480 px, or with no room beside the anchor,
 * the popup is a sheet at the bottom with the anchor scrolled into view above it. Nothing animates.
 * A step whose route is not the current screen waits for it: its popup says "Open the X screen to continue".
 * A route is the frame's location hash without its '#' ('' when none), recorded and compared as just that, never
 * the file (each saved version is a new file); a step with route '' shows on any screen.
 * The version's saved steps are kept apart from a preview's: a start without steps plays the saved ones, and a
 * preview has no "Don't show again".
 */
(function () {
  'use strict';

  var MAX_STEPS = 10;
  var MAX_TITLE = 80;
  var MAX_BODY = 280;
  var MAX_SELECTOR = 512;
  var MAX_ROUTE = 300;
  var SHEET_BELOW = 480;
  var GAP = 8;
  var POPUP_WIDTH = 320;
  var ROUTE_POLL_MS = 400;
  var PREFIX = 'voc-wt-';
  var TYPE = 'voc-walkthrough';
  // The script element running this file (null when evaluated otherwise): the server's block is right before it.
  var OWN_SCRIPT = document.currentScript;

  // ---- Steps ---------------------------------------------------------------------------
  function text(value, limit) {
    if (typeof value !== 'string') return '';
    var s = value.replace(/\s+/g, ' ').trim();
    return s.length > limit ? s.slice(0, limit) : s;
  }

  function share(value) {
    var n = Number(value);
    return isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
  }

  /** One step as this file uses it, or null when it is not a step. */
  function cleanStep(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var title = text(raw.title, MAX_TITLE);
    var body = text(raw.body, MAX_BODY);
    if (!title || !body) return null;
    var selector = typeof raw.selector === 'string' && raw.selector.length <= MAX_SELECTOR ? raw.selector.trim() : '';
    var anchor = null;
    if (raw.anchor && typeof raw.anchor === 'object' && raw.anchor.bbox && typeof raw.anchor.bbox === 'object') {
      var b = raw.anchor.bbox;
      anchor = {
        route: typeof raw.anchor.route === 'string' ? raw.anchor.route.slice(0, MAX_ROUTE) : '',
        bbox: { x: share(b.x), y: share(b.y), w: share(b.w), h: share(b.h) }
      };
    }
    if (!selector && !anchor) return null;
    return { title: title, body: body, selector: selector, anchor: anchor };
  }

  function cleanSteps(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX_STEPS; i += 1) {
      var step = cleanStep(list[i]);
      if (step) out.push(step);
    }
    return out;
  }

  /**
   * The server's block: the element right before the script holding this file, else the LAST element with the
   * block's id. Never the first: a block the prototype's own markup carries earlier must not win.
   */
  function stepsBlock(doc) {
    var before = OWN_SCRIPT && OWN_SCRIPT.previousElementSibling;
    if (before && before.id === 'voc-walkthrough-steps') return before;
    var all = doc.querySelectorAll('[id="voc-walkthrough-steps"]');
    return all.length ? all[all.length - 1] : null;
  }

  function readSteps(doc) {
    var node = stepsBlock(doc);
    if (!node) return [];
    try { return cleanSteps(JSON.parse(node.textContent || '{}').steps); } catch (e) { return []; }
  }

  // ---- Routes ----------------------------------------------------------------------------
  /**
   * The screen the prototype shows, in the one route vocabulary of a step: the frame's location hash without its
   * '#' ('' when none). Never the file: every saved version is a new file, and its steps must still show there.
   */
  function currentRoute(loc) {
    var l = loc || window.location;
    var hash = l && l.hash ? l.hash : '';
    return hash.replace(/^#/, '').slice(0, MAX_ROUTE);
  }

  /** A step's screen is "here" when it names none ('' shows on any screen), or this exact route. */
  function onRoute(step, loc) {
    var route = step.anchor ? step.anchor.route : '';
    return !route || route === currentRoute(loc);
  }

  /** "#/checkout" → "Checkout": the screen's name as the waiting step says it. */
  function screenName(route) {
    var words = String(route || '').replace(/[#/?=&._-]+/g, ' ').trim();
    if (!words) return 'next';
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // ---- Anchors ---------------------------------------------------------------------------
  function findTarget(step) {
    if (!step.selector) return null;
    try { return document.querySelector(step.selector); } catch (e) { return null; }
  }

  /** The anchor's box in the viewport: the element's, else the recorded position. */
  function anchorRect(step) {
    var target = findTarget(step);
    if (target) return { target: target, rect: target.getBoundingClientRect() };
    if (!step.anchor) return { target: null, rect: null };
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var b = step.anchor.bbox;
    var left = b.x * vw;
    var top = b.y * vh;
    return { target: null, rect: { left: left, top: top, width: b.w * vw, height: b.h * vh, right: left + b.w * vw, bottom: top + b.h * vh } };
  }

  // ---- UI ------------------------------------------------------------------------------------
  var BASE = 'font:14px/1.45 system-ui,-apple-system,sans-serif;box-sizing:border-box;';
  var BUTTON = BASE + 'padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid #9ca3af;background:#fff;color:#111827;';
  var PRIMARY = BASE + 'padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid #111827;background:#111827;color:#fff;';
  var LINK = BASE + 'padding:6px 4px;border:0;background:none;color:#374151;text-decoration:underline;cursor:pointer;';
  var FOCUS_CSS = '#' + PREFIX + 'popup button:focus-visible,#' + PREFIX + 'popup:focus-visible' +
    '{outline:3px solid #1d4ed8;outline-offset:2px;}';

  var state = {
    saved: [], steps: [], preview: false, index: -1, framed: false, port: null, returnFocus: null,
    picking: false, poll: 0
  };

  function el(tag, attrs, content) {
    var node = document.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    if (content) node.textContent = content;
    return node;
  }

  function hasParentFrame() {
    try { return window.parent && window.parent !== window; } catch (e) { return false; }
  }

  function post(message) {
    message.type = TYPE;
    if (state.port) state.port.postMessage(message);
  }

  function ensureStyle() {
    if (document.getElementById(PREFIX + 'style')) return;
    var style = el('style', { id: PREFIX + 'style' });
    style.textContent = FOCUS_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function liveRegion() {
    var live = document.getElementById(PREFIX + 'live');
    if (live) return live;
    live = el('div', { id: PREFIX + 'live', 'aria-live': 'polite', role: 'status',
      style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;' });
    document.body.appendChild(live);
    return live;
  }

  function removeById(id) {
    var node = document.getElementById(id);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function clearOutline() { removeById(PREFIX + 'outline'); }

  /** A thick dark border inside a dashed white ring: visible on any colour, and its shape is the cue. */
  function drawOutline(rect) {
    clearOutline();
    if (!rect) return;
    var box = el('div', { id: PREFIX + 'outline', 'aria-hidden': 'true', style: 'position:fixed;pointer-events:none;z-index:2147483645;' +
      'left:' + (rect.left - 4) + 'px;top:' + (rect.top - 4) + 'px;width:' + (rect.width + 8) + 'px;height:' + (rect.height + 8) + 'px;' +
      'border:3px solid #111827;border-radius:6px;outline:2px dashed #fff;outline-offset:1px;' });
    document.body.appendChild(box);
  }

  function clampLeft(left, width, vw) {
    return Math.max(GAP, Math.min(left, vw - width - GAP));
  }

  /** Where the popup goes beside the anchor (below, else above), kept inside the window; null when it does not fit. */
  function besideTop(rect, height, vh) {
    if (height > vh - 2 * GAP) return null;
    if (rect.bottom + GAP + height <= vh - GAP) return Math.max(GAP, rect.bottom + GAP);
    if (rect.top - GAP - height >= GAP) return Math.min(rect.top - GAP - height, vh - GAP - height);
    return null;
  }

  /**
   * Beside the anchor when there is room (below, else above), else a sheet at the bottom; always inside the frame's
   * window. Its height is measured at the width it will have (its buttons wrap at that width), never guessed.
   */
  function place(popup, rect) {
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var sheet = 'position:fixed;left:0;right:0;bottom:0;width:auto;max-height:55vh;overflow-y:auto;border-radius:12px 12px 0 0;';
    var top = null;
    var width = Math.min(POPUP_WIDTH, vw - 2 * GAP);
    var left = 0;
    if (vw >= SHEET_BELOW && rect) {
      left = clampLeft(rect.left, width, vw);
      popup.setAttribute('style', popup.getAttribute('data-style') + 'position:fixed;visibility:hidden;left:0;top:0;width:' + width + 'px;');
      top = besideTop(rect, popup.getBoundingClientRect().height || popup.offsetHeight || 0, vh);
    }
    if (top === null) {
      popup.setAttribute('style', popup.getAttribute('data-style') + sheet);
      return 'sheet';
    }
    popup.setAttribute('style', popup.getAttribute('data-style') + 'position:fixed;width:' + width + 'px;left:' + left + 'px;top:' + top + 'px;');
    return 'beside';
  }

  /** Instant, never smooth: the popup is placed by the anchor's box right after (and nothing animates). */
  function bringIntoView(target, sheet) {
    if (!target || typeof target.scrollIntoView !== 'function') return;
    try { target.scrollIntoView({ block: sheet ? 'start' : 'nearest', inline: 'nearest', behavior: 'auto' }); } catch (e) { /* old engine */ }
  }

  function stopPolling() {
    if (state.poll) window.clearInterval(state.poll);
    state.poll = 0;
  }

  function button(id, label, style, onClick) {
    var b = el('button', { id: PREFIX + id, type: 'button', style: style }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  /** The popup of step `index` (its route reached or not). */
  function render(index) {
    var step = state.steps[index];
    var total = state.steps.length;
    var here = onRoute(step);
    removeById(PREFIX + 'popup');
    var popup = el('div', { id: PREFIX + 'popup', role: 'dialog', tabindex: '-1',
      'aria-labelledby': PREFIX + 'title', 'aria-describedby': PREFIX + 'body' });
    popup.setAttribute('data-style', BASE + 'z-index:2147483647;padding:14px;border-radius:12px;background:#fff;color:#111827;' +
      'border:1px solid #d1d5db;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:100vw;');
    popup.appendChild(el('p', { id: PREFIX + 'count', style: 'margin:0 0 4px;font-size:12px;color:#4b5563;' }, 'Step ' + (index + 1) + ' of ' + total));
    popup.appendChild(el('h2', { id: PREFIX + 'title', style: 'margin:0 0 6px;font-size:15px;font-weight:600;' }, step.title));
    popup.appendChild(el('p', { id: PREFIX + 'body', style: 'margin:0 0 10px;' }, step.body));
    if (!here) {
      popup.appendChild(el('p', { id: PREFIX + 'wait', style: 'margin:0 0 10px;font-weight:600;' },
        'Open the ' + screenName(step.anchor.route) + ' screen to continue'));
    }
    var row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;' });
    var back = button('back', 'Back', BUTTON, function () { go(state.index - 1); });
    back.disabled = index === 0;
    var next = button('next', index === total - 1 ? 'Done' : 'Next', PRIMARY, function () { advance(); });
    next.disabled = !here;
    row.appendChild(back);
    row.appendChild(next);
    row.appendChild(button('skip', 'Skip', LINK, function () { finish('skipped'); }));
    // A preview is the editor's unsaved steps, not the viewer's walkthrough: nothing to stop showing.
    if (!state.preview) row.appendChild(button('dont', "Don't show again", LINK, function () { finish('dont-show-again'); }));
    popup.appendChild(row);
    if (!state.framed) {
      popup.appendChild(el('p', { style: 'margin:8px 0 0;font-size:12px;color:#4b5563;' },
        "Opened on its own, \"Don't show again\" lasts until this page is reloaded."));
    }
    popup.addEventListener('keydown', onPopupKey);
    document.body.appendChild(popup);
    // The anchor is scrolled into view first, so the popup is placed by where it is, not where it was.
    if (here) bringIntoView(findTarget(step), false);
    var found = here ? anchorRect(step) : { target: null, rect: null };
    if (place(popup, found.rect) === 'sheet') bringIntoView(found.target, true);
    drawOutline(found.target ? found.target.getBoundingClientRect() : found.rect);
    liveRegion().textContent = 'Step ' + (index + 1) + ' of ' + total + ': ' + step.title;
    stopPolling();
    if (!here) state.poll = window.setInterval(function () { if (onRoute(step)) render(state.index); }, ROUTE_POLL_MS);
    return popup;
  }

  function go(index) {
    if (index < 0 || index >= state.steps.length) return;
    state.index = index;
    render(index).focus();
  }

  function advance() {
    if (state.index >= state.steps.length - 1) finish('done');
    else go(state.index + 1);
  }

  function close() {
    stopPolling();
    removeById(PREFIX + 'popup');
    clearOutline();
    document.removeEventListener('keydown', onDocumentKey, true);
    var back = state.returnFocus;
    state.index = -1;
    state.returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
  }

  /** Closes it and tells the host how: done, skipped, or dont-show-again (framed, the host keeps it for the series). */
  function finish(event) {
    close();
    post({ event: event });
  }

  function onPopupKey(e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.index - 1); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (onRoute(state.steps[state.index])) advance();
    }
  }

  // Esc skips wherever focus is in the prototype, while the walkthrough is open (and no element is being picked).
  function onDocumentKey(e) {
    if (e.key === 'Escape' && state.index >= 0 && !state.picking) {
      e.preventDefault();
      e.stopPropagation();
      finish('skipped');
    }
  }

  /**
   * Plays the version's saved steps, or with `steps` the editor's unsaved ones as a preview. The saved steps are
   * kept apart (state.saved): a start without steps always plays them again, never a preview's.
   */
  function start(index, steps) {
    var playing = steps ? cleanSteps(steps) : state.saved;
    if (!playing.length) return;
    state.steps = playing;
    state.preview = Boolean(steps);
    var from = Math.min(Math.max(Number(index) || 0, 0), state.steps.length - 1);
    if (state.index < 0) state.returnFocus = document.activeElement;
    ensureStyle();
    document.addEventListener('keydown', onDocumentKey, true);
    state.index = from;
    render(from).focus();
  }

  // ---- The editor's element picker --------------------------------------------------------
  /** The pin widget's stable selector (every server-written version has the widget); without it, none: the step keeps its position. */
  function selectorOf(target) {
    var widget = window.VoCPinWidget;
    var selector = widget && typeof widget.buildSelector === 'function' ? widget.buildSelector(target, document) : '';
    return typeof selector === 'string' ? selector.slice(0, MAX_SELECTOR) : '';
  }

  function isOwn(node) {
    for (var n = node; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && (n.id.indexOf(PREFIX) === 0 || n.id.indexOf('voc-pin-') === 0)) return true;
    }
    return false;
  }

  function round(value) { return Math.round(share(value) * 10000) / 10000; }

  /** The element's place as a step records it: its selector (when one fits) and its box as shares of the viewport. */
  function pickedMessage(target) {
    var r = target.getBoundingClientRect();
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var box = { x: round(r.left / vw), y: round(r.top / vh), w: round(r.width / vw), h: round(r.height / vh) };
    var message = { event: 'picked', anchor: { route: currentRoute(), bbox: box } };
    var selector = selectorOf(target);
    if (selector) message.selector = selector;
    return message;
  }

  /** Turns picking on or off: the capture listeners, the crosshair and the hint go together. */
  function setPicking(on) {
    var listen = on ? 'addEventListener' : 'removeEventListener';
    [['click', onPick], ['keydown', onPickKey]].forEach(function (pair) { document[listen](pair[0], pair[1], true); });
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    state.picking = on;
    removeById(PREFIX + 'pick-hint');
    if (!on) return;
    document.body.appendChild(el('div', { id: PREFIX + 'pick-hint', role: 'status', style: BASE +
      'position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;padding:8px 12px;border-radius:8px;' +
      'background:#111827;color:#fff;text-align:center;' }, 'Click the element this step is about. Press Esc to cancel.'));
  }

  /** Swallow the event the picker answers, so the prototype does not act on it too. */
  function consume(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onPick(e) {
    var target = e.target;
    if (target && target.nodeType === 1 && !isOwn(target)) {
      consume(e);
      setPicking(false);
      post(pickedMessage(target));
    }
  }

  function onPickKey(e) {
    if (e.key === 'Escape') {
      consume(e);
      setPicking(false);
      post({ event: 'pick-cancelled' });
    }
  }

  function startPicking() {
    if (state.index >= 0) close();
    setPicking(false);
    setPicking(true);
  }

  // ---- The host -----------------------------------------------------------------------------
  function onHostMessage(data) {
    if (!data || data.type !== TYPE) return;
    if (data.action === 'start') start(data.step, Array.isArray(data.steps) ? data.steps : null);
    else if (data.action === 'pick') startPicking();
  }

  /** The host's way in: a private port handed over with the ready message (as the pin widget does). */
  function handshake() {
    if (typeof window.MessageChannel !== 'function') return;
    var channel = new window.MessageChannel();
    channel.port1.onmessage = function (e) { onHostMessage(e.data); };
    state.port = channel.port1;
    // The host's origin when this document has one; an opaque one (a srcdoc frame) cannot be named, so '*': the
    // message holds only a count, and the port only starts and picks.
    var origin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*';
    window.parent.postMessage({ type: TYPE, event: 'ready', steps: state.saved.length }, origin, [channel.port2]);
  }

  function init() {
    if (state.initialised) return;
    state.initialised = true;
    var mount = function () {
      state.saved = readSteps(document);
      state.steps = state.saved;
      state.framed = hasParentFrame();
      // An editor may add the first steps of a version with none: the framed runtime still offers its port.
      if (state.framed) handshake();
      else if (state.steps.length) start(0);
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }

  window.VoCWalkthrough = Object.freeze({
    init: init,
    cleanSteps: cleanSteps,
    currentRoute: currentRoute,
    screenName: screenName,
    start: function (step) { start(step, null); },
    state: function () {
      return { index: state.index, steps: state.steps.length, saved: state.saved.length, preview: state.preview, picking: state.picking };
    }
  });
})();
