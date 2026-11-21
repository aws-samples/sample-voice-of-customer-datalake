// Trial workspaces in the dev mock (7.71.00), in the wire shapes of lambda/api/workspaces_handler.py,
// lambda/shared/trials.py and lambda/shared/trial_state.py (docs/multi-workspace.md, "Trial workspaces"):
//   POST /platform/workspaces {name, slug, trial: {days?, pack?}}   (mock-workspaces.js) → the workspace with `trial`
//   POST /platform/workspaces/{ws}/trial/extend {days}  → {trial}: 14, 30 or 60 more days from its end (or from now
//        once it ended); a paused trial is resumed (its pause cleared). 400 for other days, 404 'Trial not found' for a
//        workspace that is no trial, 409 for a converted one
//   POST /platform/workspaces/{ws}/trial/convert        → {trial}: converted (a converted one is answered as it is)
//   GET  /me/workspaces/current  (mock-workspaces.js) → `trial` (trialSummary) and `playbook`
// Platform admins only (403 otherwise), like the server. The mock never schedules or pauses on its own: the dev switch
// `PUT /__mock/workspaces {"enabled": true, "trial": "running" | "paused"}` makes Acme Outfitters a trial in that
// state. Nothing here deletes anything, as on the server.

const TRIAL_ROUTE = /^\/platform\/workspaces\/([^/]+)\/trial\/(extend|convert)$/;
const TRIAL_DAYS = [14, 30, 60];
const DAY_MS = 86_400_000;
const TRIAL_NOT_FOUND = 'Trial not found';
const TRIAL_ALREADY_CONVERTED = 'This trial was converted: it is a regular workspace now, with no end';
export const TRIAL_PAUSED = 'This trial workspace is paused: a platform admin extends or converts it to turn its plugins and forms back on. Nothing was deleted, and reads and the export still work';

const atSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', '+00:00');

/** A create's `trial` (or none): `{value}` for a valid one, `{refusal}` for a bad one, `{value: null}` for none. */
export function newTrial(body, creator) {
  if (body === undefined || body === null) return { value: null };
  const days = body.days ?? 30;
  if (typeof body !== 'object' || !TRIAL_DAYS.includes(days)) return { refusal: 'trial.days must be 14, 30 or 60' };
  const now = Date.now();
  return { value: { days, created_at: atSecond(now), created_by: creator, expires_at: atSecond(now + days * DAY_MS),
    pack: body.pack ?? { forms: [], categories: false, playbooks: false }, extended: [], paused_at: null, paused: null,
    converted_at: null, converted_by: null } };
}

/** A trial for the dev switch: running (ends in 12 days) or paused (since yesterday, 2 plugins and 1 form off). */
export function switchTrial(state, creator) {
  if (state !== 'running' && state !== 'paused') return null;
  const now = Date.now();
  const paused = state === 'paused';
  return { days: 30, created_at: atSecond(now - (paused ? 31 : 18) * DAY_MS), created_by: creator,
    expires_at: atSecond(now + (paused ? -DAY_MS : 12 * DAY_MS)), pack: { forms: ['workshop'], categories: true, playbooks: true },
    extended: [], paused_at: paused ? atSecond(now - DAY_MS) : null,
    paused: paused ? { plugins: ['webscraper', 'app_reviews_ios'], forms: ['ff_workshop'] } : null,
    converted_at: null, converted_by: null };
}

export const isPaused = (trial) => Boolean(trial && trial.paused_at && !trial.converted_at);

/** What every member reads (trial_state.py `trial_summary`), or null. */
export function trialSummary(trial) {
  if (!trial) return null;
  const paused = isPaused(trial);
  return { days: trial.days, expires_at: trial.expires_at, paused_at: paused ? trial.paused_at : null,
    converted_at: trial.converted_at,
    paused: paused ? { plugins: trial.paused.plugins.length, forms: trial.paused.forms.length } : null };
}

/** The platform console's view (trials.py `trial_view`), or null. */
export function trialView(trial) {
  if (!trial) return null;
  return { ...trial, paused: isPaused(trial) ? trial.paused : null };
}

function extend(workspace, body, send, caller) {
  const { trial } = workspace;
  if (!TRIAL_DAYS.includes(body?.days)) return send(400, { success: false, error: 'days must be 14, 30 or 60' });
  if (trial.converted_at) return send(409, { success: false, error: TRIAL_ALREADY_CONVERTED, code: 'trial_converted' });
  const now = Date.now();
  const expires = atSecond(Math.max(Date.parse(trial.expires_at), now) + body.days * DAY_MS);
  const entry = { at: atSecond(now), by: caller, days: body.days, expires_at: expires,
    ...(isPaused(trial) ? { resumed: { plugins: trial.paused.plugins.length, forms: trial.paused.forms.length } } : {}) };
  workspace.trial = { ...trial, expires_at: expires, extended: [...trial.extended, entry], paused_at: null, paused: null };
  return send(200, { trial: trialView(workspace.trial) });
}

function convert(workspace, send, caller) {
  if (!workspace.trial.converted_at) {
    workspace.trial = { ...workspace.trial, converted_at: atSecond(Date.now()), converted_by: caller, paused_at: null, paused: null };
  }
  return send(200, { trial: trialView(workspace.trial) });
}

/**
 * `POST /platform/workspaces/{ws}/trial/extend|convert`; true when the request was taken. `context` gives the mock's
 * workspaces (`workspaces()`), whether the caller is a platform admin, and their sub.
 */
export function handleTrialRoutes(req, res, url, send, shared, context) {
  const match = TRIAL_ROUTE.exec(url.pathname);
  if (match === null || req.method !== 'POST') return false;
  shared.collectJson(req, res, (body) => {
    if (!context.isPlatformAdmin()) return send(403, { success: false, error: 'Platform admin access required' });
    const workspace = context.workspaces().find((candidate) => candidate.id === decodeURIComponent(match[1]));
    if (!workspace?.trial || workspace.status !== 'active') return send(404, { success: false, error: TRIAL_NOT_FOUND });
    return match[2] === 'extend' ? extend(workspace, body, send, context.sub) : convert(workspace, send, context.sub);
  });
  return true;
}
