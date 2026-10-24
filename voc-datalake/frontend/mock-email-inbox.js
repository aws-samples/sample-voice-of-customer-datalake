// Email inbox mock: GET|PUT /settings/email-inbox and POST /settings/email-inbox/feedback-type-dimension
// in the settings_handler wire shape ({enabled, domain, addresses, rule_set, rule_set_needs_activation,
// caps, defaults, today: {date, received, accepted, model_calls, deferred, dropped, deduped}, pii,
// profile_configured, feedback_type_dimension, updated_at}; {success: false, message} on 400).
// Stateful for the life of the mock process: the inbox is deployed on voc.example.com with a few
// counters already set, so every part of the card renders.
// Wired into mock-server.js by handleDomainModules.

const STATUS_ROUTE = '/settings/email-inbox';
const DIMENSION_ROUTE = '/settings/email-inbox/feedback-type-dimension';
const DOMAIN = 'voc.example.com';
const ALIASES = ['feedback', 'ideas', 'bugs', 'reviews'];
const DEFAULT_CAPS = { daily_cap: 200, sender_daily_cap: 20, daily_model_calls: 400 };
const CAP_BOUNDS = { daily_cap: [1, 5000], sender_daily_cap: [1, 500], daily_model_calls: [0, 10000] };
const DROP_REASONS = ['spam', 'virus', 'auto_reply', 'bulk', 'loop_sender', 'sender_cap',
  'no_text', 'unparseable', 'too_large'];
const DEDUPE_REASONS = ['duplicate_message', 'seen_in_thread', 'no_new_info', 'forward_duplicate'];
const FEEDBACK_TYPES = ['review', 'feature_request', 'bug', 'question', 'praise'];

const state = {
  caps: { ...DEFAULT_CAPS },
  updated_at: null,
};

function counters(reasons, seeded) {
  return Object.fromEntries(reasons.map((reason) => [reason, seeded[reason] ?? 0]));
}

function view(shared) {
  return {
    enabled: true,
    domain: DOMAIN,
    addresses: ALIASES.map((alias) => `${alias}@${DOMAIN}`),
    rule_set: 'voc-email-intake-123456789012-us-east-1',
    rule_set_needs_activation: false,
    caps: { ...state.caps },
    defaults: { ...DEFAULT_CAPS },
    today: {
      date: new Date().toISOString().slice(0, 10),
      received: 14, accepted: 9, model_calls: 6, deferred: 0,
      dropped: counters(DROP_REASONS, { spam: 2, auto_reply: 1 }),
      deduped: counters(DEDUPE_REASONS, { duplicate_message: 1, no_new_info: 1 }),
    },
    pii: 'redact',
    profile_configured: false,
    feedback_type_dimension: shared.dimensionsConfig().some((dimension) => dimension.key === 'feedback_type'),
    updated_at: state.updated_at,
  };
}

function capsError(body) {
  for (const [key, [low, high]] of Object.entries(CAP_BOUNDS)) {
    const value = body?.[key];
    if (!Number.isInteger(value) || value < low || value > high) {
      return `${key} must be a whole number from ${low} to ${high}`;
    }
  }
  return null;
}

function saveCaps(body, shared) {
  const error = capsError(body);
  if (error) return [400, { success: false, message: error }];
  state.caps = Object.fromEntries(Object.keys(CAP_BOUNDS).map((key) => [key, body[key]]));
  state.updated_at = new Date().toISOString();
  return [200, { success: true, ...view(shared) }];
}

function createDimension(shared) {
  // shared.dimensionsConfig() is mock-dimensions.js's live list, so GET /settings/dimensions sees it too.
  const dimensions = shared.dimensionsConfig();
  const created = !dimensions.some((dimension) => dimension.key === 'feedback_type');
  if (created) {
    dimensions.push({ key: 'feedback_type', label: 'Feedback type', infer: true,
      values: FEEDBACK_TYPES.map((name) => ({ name })) });
  }
  return [200, { success: true, created, dimensions }];
}

/** Handle `/settings/email-inbox*`; returns true when the request was taken. */
export function handleEmailInboxRoutes(req, res, url, send, shared) {
  if (url.pathname !== STATUS_ROUTE && url.pathname !== DIMENSION_ROUTE) return false;
  const key = `${req.method} ${url.pathname}`;
  if (key === `GET ${STATUS_ROUTE}`) {
    send(200, view(shared));
    return true;
  }
  if (key !== `PUT ${STATUS_ROUTE}` && key !== `POST ${DIMENSION_ROUTE}`) {
    send(405, { success: false, message: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const [status, payload] = key === `PUT ${STATUS_ROUTE}` ? saveCaps(body, shared) : createDimension(shared);
    send(status, payload);
  });
  return true;
}
