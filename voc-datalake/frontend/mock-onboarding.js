// Onboarding-buddy mock: GET|PUT /settings/my-onboarding in the
// lambda/shared/onboarding.py wire shape ({state, hidden_until, updated_at,
// visible, start_page, guide, subscribe_prompt, dismissed_decision_runs, playbook,
// playbook_done, signals}; {success: false, error} on 400). A PUT changes
// only the fields it names. Stateful for the life of the mock process (one mock
// caller). `signals` are derived from the shared
// fixtures, like the real route reads the aggregates table: feedback present
// iff any mock feedback exists, a form configured iff any mock form exists; the
// chosen playbook's server signals (7.66.00, schemas/playbooks.json) read false
// but the QA step's test response, true once a form exists. Start with
// MOCK_PLAYBOOK=qa (or product, scrum_master, engineering) to open with a role chosen.
// Start with MOCK_ONBOARDING_STATE=dismissed (or hidden/skipped) to open the
// normal home first, MOCK_START_PAGE=dashboard to open on the dashboard, and
// MOCK_ONBOARDING_GUIDE=skipped to open "How it works" collapsed.
// Wired into mock-server.js by handleDomainModules.

import { readFileSync } from 'node:fs';

const ROUTE = '/settings/my-onboarding';
// The role playbooks' catalogue, the file the SPA and lambda/shared/playbooks.py read.
const PLAYBOOKS = JSON.parse(readFileSync(new URL('../schemas/playbooks.json', import.meta.url), 'utf8'));
const ROLES = PLAYBOOKS.roles;
const STEP_IDS = new Set(Object.values(PLAYBOOKS.steps).flat().map((step) => step.id));
const SERVER_SIGNALS = ['objectives_set', 'feedback_form_configured', 'form_test_response'];
const MAX_DONE = 40;
const STATES = ['active', 'hidden', 'dismissed', 'skipped'];
const START_PAGES = ['home', 'dashboard'];
const GUIDES = ['open', 'skipped'];
const SUBSCRIBE_PROMPTS = ['shown', 'dismissed'];
const FIELDS = ['state', 'start_page', 'guide', 'subscribe_prompt', 'dismiss_decision_run', 'playbook', 'playbook_done'];
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
  playbook: ROLES.includes(process.env.MOCK_PLAYBOOK) ? process.env.MOCK_PLAYBOOK : null,
  playbook_done: [],
};

/** The chosen playbook's server signals, as shared/playbooks.py `server_signals_of` lists them. */
function playbookSignals(shared) {
  const steps = preference.playbook === null ? [] : PLAYBOOKS.steps[preference.playbook];
  const wanted = SERVER_SIGNALS.filter((name) => name !== 'feedback_form_configured'
    && steps.some((step) => step.evidence === name));
  return Object.fromEntries(wanted.map((name) => [name, name === 'form_test_response' && shared.mockFeedbackForms.length > 0]));
}

function view(shared) {
  const snoozed = preference.state === 'hidden' && Date.parse(preference.hidden_until) > Date.now();
  return {
    ...preference,
    visible: preference.state === 'active' || (preference.state === 'hidden' && !snoozed),
    signals: {
      feedback_present: shared.mockFeedback.length > 0,
      feedback_form_configured: shared.mockFeedbackForms.length > 0,
      ...playbookSignals(shared),
    },
  };
}

/** The fields that take one of a list (the real CHOICES), in the order their refusals are checked. */
const CHOICES = [['state', STATES], ['start_page', START_PAGES], ['guide', GUIDES], ['subscribe_prompt', SUBSCRIBE_PROMPTS]];

/** The 400 of a ``playbook`` or ``playbook_done`` the real playbooks.validate_role / validate_done refuse, else null. */
function playbookRefusal(body) {
  if ('playbook' in body && body.playbook !== null && !ROLES.includes(body.playbook)) {
    return `playbook must be one of: ${ROLES.join(', ')}, or null`;
  }
  if (!('playbook_done' in body)) return null;
  const done = body.playbook_done;
  if (!Array.isArray(done) || done.length > MAX_DONE) return `playbook_done must be a list of at most ${MAX_DONE} step ids`;
  return done.some((step) => !STEP_IDS.has(step)) ? 'playbook_done names a step no playbook has' : null;
}

/** The 400 the real validate_preference answers for ``body``, else null. */
function refusal(body) {
  const given = body && typeof body === 'object' ? Object.keys(body) : [];
  const unknown = given.filter((k) => !FIELDS.includes(k)).sort((a, b) => a.localeCompare(b));
  if (unknown.length > 0) return `Unknown field(s): ${unknown.join(', ')}`;
  if (!given.some((k) => FIELDS.includes(k))) return `Give at least one of: ${FIELDS.join(', ')}`;
  const choice = CHOICES.find(([field, allowed]) => field in body && !allowed.includes(body[field]));
  if (choice) return `${choice[0]} must be one of: ${choice[1].join(', ')}`;
  if ('dismiss_decision_run' in body && !(typeof body.dismiss_decision_run === 'string' && RUN_ID.test(body.dismiss_decision_run))) {
    return 'dismiss_decision_run must be an agent run id';
  }
  return playbookRefusal(body);
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
  if ('playbook' in body) preference.playbook = body.playbook;
  if ('playbook_done' in body) preference.playbook_done = [...new Set(body.playbook_done)].sort((a, b) => a.localeCompare(b));
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
