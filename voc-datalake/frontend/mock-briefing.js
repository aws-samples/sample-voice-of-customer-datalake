// Morning brief mock (docs/briefing.md): GET|PUT /settings/my-briefing,
// GET /settings/my-briefing/brief, POST /settings/my-briefing/refresh and
// PUT /settings/my-briefing/cards, in the shared/briefing_prefs.py,
// shared/briefing_store.py and shared/briefing_requests.py wire shapes
// ({success: false, error} on 400/404). Stateful for the life of the mock
// process (one mock caller). The brief starts READY with cards built from the
// shared feedback fixtures, so Home shows data on first open; a refresh answers
// `pending`, then the brief turns ready again after BUILD_MS; a refresh within
// UP_TO_DATE_MS of the last build answers `up_to_date` (the real free debounce).
// An email subscription starts `pending` and is "confirmed" CONFIRM_MS later.
// Which language (docs/briefing.md): `language_source` is `ui` (follow the app)
// until the reader picks a brief language (`chosen`); a refresh body
// `{language}` moves a `ui`-sourced language, and a brief built in another
// language than the current one is rebuilt (the real settings marker).
// A restricted caller (mock-scope.js) gets only the cards that name no other
// category, and a headline that names none.

import { isScopeRestricted, scopeAdmits } from './mock-scope.js';
// Wired into mock-server.js by handleDomainModules.

const BASE = '/settings/my-briefing';
const LANGUAGES = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl'];
const FIELDS = ['enabled', 'hour', 'time_zone', 'language', 'language_source', 'instructions', 'email'];
const LANGUAGE_SOURCES = ['ui', 'chosen'];
const CARD_STATES = ['seen', 'dismissed', 'acted'];
const MAX_INSTRUCTIONS = 2000;
const BUILD_MS = 2500;
const UP_TO_DATE_MS = 60_000;
const CONFIRM_MS = 10_000;

const preferences = {
  enabled: false, hour: 8, time_zone: 'UTC', language: 'en', language_source: 'ui', instructions: '', email: false,
  email_status: 'off', updated_at: null,
};
const confirmAt = { value: 0 };

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** `{kind}_{16 hex}` like shared/brief_cards.card_id: stable per kind and day. */
function cardId(kind, n) {
  const stamp = (today().replaceAll('-', '') + String(n)).padEnd(16, '0').slice(0, 16);
  return `${kind}_${stamp}`;
}

function cardsFrom(feedback) {
  const ids = feedback.map((item) => String(item.feedback_id));
  const category = String(feedback[0]?.category ?? 'delivery');
  return [
    { id: cardId('alert_urgent', 1), kind: 'alert_urgent', layer: 'org', severity: 'alert',
      title: '4 urgent reviews this week (previous week: 1)', body: 'Most are about late deliveries.',
      facts: { current: 4, previous: 1, categories: [category] }, actions: [], feedback_ids: ids.slice(0, 2), urls: [] },
    { id: cardId('whats_new', 2), kind: 'whats_new', layer: 'org', severity: 'info',
      title: `${feedback.length * 6} reviews in the last 7 days`, body: 'Up 18% on the week before.',
      facts: { current: feedback.length * 6, previous: feedback.length * 5, change_pct: 18 },
      actions: [], feedback_ids: [], urls: [] },
    { id: cardId('trending_topic', 3), kind: 'trending_topic', layer: 'org', severity: 'info',
      title: `${category} is trending: 9 reviews this week`, body: 'Customers mention the courier more often.',
      facts: { category, current: 9, previous: 4, change_pct: 125,
        quotes: feedback.slice(0, 2).map((item) => ({ feedback_id: String(item.feedback_id), text: String(item.original_text ?? '').slice(0, 120) })) },
      actions: [], feedback_ids: ids.slice(0, 3), urls: [] },
    { id: cardId('personal_note', 4), kind: 'personal_note', layer: 'personal', severity: 'info',
      title: 'Your objective "Faster delivery" is at risk', body: 'Late-delivery complaints rose this week.',
      facts: {}, actions: [{ label: 'Ask the assistant', prompt: 'Which delivery issues hurt my objective most this week?' }],
      feedback_ids: [], urls: [] },
    { id: cardId('todo_memory_review', 5), kind: 'todo_memory_review', layer: 'personal', severity: 'info',
      title: '2 memories wait for your review', body: '', facts: { company: 2, personal: 0 },
      actions: [], feedback_ids: [], urls: [] },
    { id: cardId('todo_mcp_tokens', 6), kind: 'todo_mcp_tokens', layer: 'personal', severity: 'info',
      title: '1 MCP token expires within 7 days', body: '', facts: { count: 1, tokens: [] },
      actions: [], feedback_ids: [], urls: [] },
  ];
}

const brief = {
  status: 'ready', day: today(), generated_at: new Date(Date.now() - 3_600_000).toISOString(), requested_at: null,
  headline: 'Deliveries are the story this morning', summary: 'Volume is up and urgent reviews cluster around late parcels.',
  language: 'en', cards: null, card_state: {},
};

/**
 * A card a restricted caller may see (shared/brief_cards drops out-of-scope cards):
 * one that names no category, or only categories in their scope (mock-scope.js).
 */
function cardInScope(card) {
  const facts = card.facts ?? {};
  const named = [...(Array.isArray(facts.categories) ? facts.categories : []), ...(facts.category ? [facts.category] : [])];
  return named.every((name) => scopeAdmits(name));
}

function briefView(shared) {
  if (brief.cards === null) brief.cards = cardsFrom(shared.mockFeedback.slice(0, 3));
  if (brief.status === 'pending' && Date.now() - Date.parse(brief.requested_at) >= BUILD_MS) {
    Object.assign(brief, { status: 'ready', day: today(), generated_at: new Date().toISOString(),
      language: preferences.language });
  }
  const scopedText = isScopeRestricted()
    ? { headline: 'A quiet morning in your categories', summary: 'Nothing new stands out in the reviews you can see.' }
    : {};
  return { ...brief, ...scopedText, cards: brief.cards.filter(cardInScope), card_state: { ...brief.card_state } };
}

function preferencesView() {
  if (preferences.email_status === 'pending' && Date.now() >= confirmAt.value) preferences.email_status = 'confirmed';
  return { ...preferences };
}

function isZone(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const CHECKS = {
  enabled: (v) => (typeof v === 'boolean' ? null : 'enabled must be true or false'),
  email: (v) => (typeof v === 'boolean' ? null : 'email must be true or false'),
  hour: (v) => (Number.isInteger(v) && v >= 0 && v <= 23 ? null : 'hour must be a whole number from 0 to 23'),
  time_zone: (v) => (isZone(v) ? null : 'time_zone must be an IANA time zone such as Europe/Paris'),
  language: (v) => (LANGUAGES.includes(v) ? null : `language must be one of: ${LANGUAGES.join(', ')}`),
  language_source: (v) => (LANGUAGE_SOURCES.includes(v)
    ? null : `language_source must be one of: ${LANGUAGE_SOURCES.join(', ')}`),
  instructions: (v) => (typeof v === 'string' && v.trim().length <= MAX_INSTRUCTIONS
    ? null : `instructions must be at most ${MAX_INSTRUCTIONS} characters`),
};

function preferencesRefusal(body) {
  const given = body && typeof body === 'object' ? Object.keys(body) : [];
  const unknown = given.filter((k) => !FIELDS.includes(k)).sort((a, b) => a.localeCompare(b));
  if (unknown.length > 0) return `Unknown field(s): ${unknown.join(', ')}`;
  if (given.length === 0) return `Give at least one of: ${FIELDS.join(', ')}`;
  return given.map((k) => CHECKS[k](body[k])).find((message) => message !== null) ?? null;
}

function savePreferences(body) {
  // A language named without a source is an explicit choice (shared/briefing_prefs.validate_changes).
  const source = 'language' in body && !('language_source' in body) ? { language_source: 'chosen' } : {};
  Object.assign(preferences, body, source, { updated_at: new Date().toISOString() });
  if (typeof body.instructions === 'string') preferences.instructions = body.instructions.trim();
  const wantsEmail = preferences.enabled && preferences.email;
  if (!wantsEmail) preferences.email_status = 'off';
  else if (preferences.email_status === 'off') {
    preferences.email_status = 'pending';
    confirmAt.value = Date.now() + CONFIRM_MS;
  }
}

/** The optional refresh body `{language}` (shared/briefing_prefs.validate_refresh). */
function refreshRefusal(body) {
  if (body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) return 'the request body must be a JSON object';
  const unknown = Object.keys(body).filter((k) => k !== 'language').sort((a, b) => a.localeCompare(b));
  if (unknown.length > 0) return `Unknown field(s): ${unknown.join(', ')}`;
  return 'language' in body ? CHECKS.language(body.language) : null;
}

/** The UI language moves a brief language the reader did not choose (briefing_requests.follow_ui_language). */
function followUiLanguage(language) {
  if (language === undefined || preferences.language_source === 'chosen' || preferences.language === language) return;
  Object.assign(preferences, { language, language_source: 'ui', updated_at: new Date().toISOString() });
}

function refresh(shared, body) {
  const current = briefView(shared);
  if (current.status === 'pending') return { status: 'pending', brief: current };
  followUiLanguage(body?.language);
  const fresh = Date.now() - Date.parse(current.generated_at) < UP_TO_DATE_MS;
  if (fresh && current.language === preferences.language) return { status: 'up_to_date', brief: current };
  Object.assign(brief, { status: 'pending', requested_at: new Date().toISOString() });
  return { status: 'pending', brief: briefView(shared) };
}

function cardsRefusal(body) {
  if (!body || typeof body !== 'object') return [400, 'Body must be an object'];
  if (typeof body.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) return [400, 'day must be YYYY-MM-DD'];
  const states = body.states;
  if (!states || typeof states !== 'object' || Object.keys(states).length === 0) {
    return [400, 'states must be a non-empty object of card id to state'];
  }
  if (Object.values(states).some((s) => !CARD_STATES.includes(s))) {
    return [400, `state must be one of: ${CARD_STATES.join(', ')}`];
  }
  if (body.day !== brief.day) return [404, 'No brief for that day'];
  return null;
}

function handlePreferences(req, res, send, shared) {
  if (req.method === 'GET') {
    send(200, preferencesView());
    return;
  }
  if (req.method !== 'PUT') {
    send(405, { success: false, error: 'Method not allowed' });
    return;
  }
  collectInto(shared, req, res, send, (body) => {
    const refused = preferencesRefusal(body);
    if (refused) return [400, { success: false, error: refused }];
    savePreferences(body);
    return [200, preferencesView()];
  });
}

function collectInto(shared, req, res, send, respond) {
  shared.collectJson(req, res, (body) => {
    const [status, payload] = respond(body);
    send(status, payload);
  });
}

function handleCards(req, res, send, shared) {
  if (req.method !== 'PUT') {
    send(405, { success: false, error: 'Method not allowed' });
    return;
  }
  collectInto(shared, req, res, send, (body) => {
    const refused = cardsRefusal(body);
    if (refused) return [refused[0], { success: false, error: refused[1] }];
    Object.assign(brief.card_state, body.states);
    return [200, { day: brief.day, card_state: { ...brief.card_state } }];
  });
}

function handleRefresh(req, res, send, shared) {
  if (req.method !== 'POST') {
    send(405, { success: false, error: 'Method not allowed' });
    return;
  }
  collectInto(shared, req, res, send, (body) => {
    const refused = refreshRefusal(body);
    if (refused) return [400, { success: false, error: refused }];
    return [200, refresh(shared, body)];
  });
}

/** Handle `/settings/my-briefing[/brief|/refresh|/cards]`; returns true when the request was taken. */
export function handleBriefingRoutes(req, res, url, send, shared) {
  const routes = {
    [BASE]: () => handlePreferences(req, res, send, shared),
    [`${BASE}/brief`]: () => (req.method === 'GET'
      ? send(200, briefView(shared)) : send(405, { success: false, error: 'Method not allowed' })),
    [`${BASE}/refresh`]: () => handleRefresh(req, res, send, shared),
    [`${BASE}/cards`]: () => handleCards(req, res, send, shared),
  };
  const route = routes[url.pathname];
  if (route === undefined) return false;
  route();
  return true;
}
