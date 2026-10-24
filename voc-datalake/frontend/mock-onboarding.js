// Onboarding-buddy mock: GET|PUT /settings/my-onboarding in the
// lambda/shared/onboarding.py wire shape ({state, hidden_until, updated_at,
// visible, start_page, guide, subscribe_prompt, dismissed_decision_runs, signals};
// {success: false, error} on 400). A PUT changes
// only the fields it names. Stateful for the life of the mock process (one mock
// caller). `signals` are derived from the shared
// fixtures, like the real route reads the aggregates table: feedback present
// iff any mock feedback exists, a form configured iff any mock form exists.
// Start with MOCK_ONBOARDING_STATE=dismissed (or hidden/skipped) to open the
// normal home first, MOCK_START_PAGE=dashboard to open on the dashboard, and
// MOCK_ONBOARDING_GUIDE=skipped to open "How it works" collapsed.
// Wired into mock-server.js by handleDomainModules.

const ROUTE = '/settings/my-onboarding';
const STATES = ['active', 'hidden', 'dismissed', 'skipped'];
const START_PAGES = ['home', 'dashboard'];
const GUIDES = ['open', 'skipped'];
const SUBSCRIBE_PROMPTS = ['shown', 'dismissed'];
const FIELDS = ['state', 'start_page', 'guide', 'subscribe_prompt', 'dismiss_decision_run'];
const RUN_ID = /^ar_[0-9a-f]{12,20}$/; // _RUN_ID_RE in shared/onboarding.py
const MAX_DISMISSED_RUNS = 50;
const HIDE_FOR_MS = 86_400_000; // HIDE_FOR in shared/onboarding.py (one day)

const initial = STATES.includes(process.env.MOCK_ONBOARDING_STATE) ? process.env.MOCK_ONBOARDING_STATE : 'active';
const preference = {
  state: initial,
  updated_at: null,
  hidden_until: initial === 'hidden' ? new Date(Date.now() + HIDE_FOR_MS).toISOString() : null,
  start_page: START_PAGES.includes(process.env.MOCK_START_PAGE) ? process.env.MOCK_START_PAGE : 'home',
  guide: GUIDES.includes(process.env.MOCK_ONBOARDING_GUIDE) ? process.env.MOCK_ONBOARDING_GUIDE : 'open',
  subscribe_prompt: 'shown',
  dismissed_decision_runs: [],
};

function view(shared) {
  const snoozed = preference.state === 'hidden' && Date.parse(preference.hidden_until) > Date.now();
  return {
    ...preference,
    visible: preference.state === 'active' || (preference.state === 'hidden' && !snoozed),
    signals: {
      feedback_present: shared.mockFeedback.length > 0,
      feedback_form_configured: shared.mockFeedbackForms.length > 0,
    },
  };
}

/** The 400 the real validate_preference answers for ``body``, else null. */
function refusal(body) {
  const given = body && typeof body === 'object' ? Object.keys(body) : [];
  const unknown = given.filter((k) => !FIELDS.includes(k)).sort((a, b) => a.localeCompare(b));
  if (unknown.length > 0) return `Unknown field(s): ${unknown.join(', ')}`;
  if (!given.some((k) => FIELDS.includes(k))) return `Give at least one of: ${FIELDS.join(', ')}`;
  if ('state' in body && !STATES.includes(body.state)) return `state must be one of: ${STATES.join(', ')}`;
  if ('start_page' in body && !START_PAGES.includes(body.start_page)) {
    return `start_page must be one of: ${START_PAGES.join(', ')}`;
  }
  if ('guide' in body && !GUIDES.includes(body.guide)) return `guide must be one of: ${GUIDES.join(', ')}`;
  if ('subscribe_prompt' in body && !SUBSCRIBE_PROMPTS.includes(body.subscribe_prompt)) {
    return `subscribe_prompt must be one of: ${SUBSCRIBE_PROMPTS.join(', ')}`;
  }
  if ('dismiss_decision_run' in body && !(typeof body.dismiss_decision_run === 'string' && RUN_ID.test(body.dismiss_decision_run))) {
    return 'dismiss_decision_run must be an agent run id';
  }
  return null;
}

function save(body) {
  const refused = refusal(body);
  if (refused) return [400, { success: false, error: refused }];
  const now = new Date();
  preference.updated_at = now.toISOString();
  if ('state' in body) {
    preference.state = body.state;
    preference.hidden_until = body.state === 'hidden' ? new Date(now.getTime() + HIDE_FOR_MS).toISOString() : null;
  }
  if ('start_page' in body) preference.start_page = body.start_page;
  if ('guide' in body) preference.guide = body.guide;
  if ('subscribe_prompt' in body) preference.subscribe_prompt = body.subscribe_prompt;
  if ('dismiss_decision_run' in body) {
    const runs = new Set([...preference.dismissed_decision_runs, body.dismiss_decision_run]);
    preference.dismissed_decision_runs = [...runs].sort((a, b) => b.localeCompare(a)).slice(0, MAX_DISMISSED_RUNS);
  }
  return null;
}

/** Handle `/settings/my-onboarding`; returns true when the request was taken. */
export function handleOnboardingRoutes(req, res, url, send, shared) {
  if (url.pathname !== ROUTE) return false;
  if (req.method === 'GET') {
    send(200, view(shared));
    return true;
  }
  if (req.method !== 'PUT') {
    send(405, { success: false, error: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const refused = save(body);
    if (refused) send(refused[0], refused[1]);
    else send(200, view(shared));
  });
  return true;
}
