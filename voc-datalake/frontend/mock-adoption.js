// The leadership view mock (7.70.00): GET /metrics/adoption in the lambda/shared/adoption_view.py wire shape
// ({scope, grain, from, to, as_of, complete, covered_from, agent_runs_counted, periods, totals, time_saved}; 400
// {success: false, error} for a bad range, as the real route answers) and GET|PUT /settings/adoption in the
// lambda/shared/adoption_routes.py shape ({baselines, defaults, note, updated_at, max_hours, max_note_chars}).
// The months are seeded from a fixed pattern (counts only, no person); the estimate is worked out from the baselines
// at read time, as the server does. Stateful for the life of the mock process; the mock caller is an admin, so the
// real routes' 403 is not reproduced. Wired into mock-server.js by handleDomainModules.

const VIEW = '/metrics/adoption';
const SETTINGS = '/settings/adoption';
// ARTIFACT_TYPES, DEFAULT_BASELINE_HOURS and ASSUMPTIONS of lambda/shared/adoption.py and adoption_view.py.
const TYPES = ['personas', 'research', 'prfaq', 'prd', 'prototype'];
const STEPS = [...TYPES, 'validation'];
const CYCLES = ['evidence_to_prd', 'prd_to_prototype', 'prototype_to_decision'];
const DEFAULTS = { personas: 1.5, research: 6, prfaq: 4, prd: 8, prototype: 16 };
const MAX_HOURS = 200;
const MAX_NOTE = 500;
const LABEL = 'Estimate, not a measurement: AI-made artifacts times the hours each would take by hand';
const ASSUMPTIONS = [
  ['ai_made_only', 'Only artifacts the AI made count: generated, revised by the AI, or built by the prototype builder. Hand-written artifacts, edits and restores save nothing.'],
  ['baseline_hours', 'Each AI-made artifact saves its baseline: the hours a person takes to make one by hand, as an admin set them, else the default shown.'],
  ['review_not_subtracted', 'The time people spend reviewing and editing an AI draft is not subtracted.'],
  ['no_hours_for_the_rest', 'Decisions, validations, assistant conversations and agent runs add no hours.'],
  ['live_projects', 'Deleted projects are not counted. Figures are as of the last daily rollup.'],
].map(([code, text]) => ({ code, text }));

const settings = { baselines: {}, note: null, updated_at: null };

const monthOf = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
function shift(month, by) {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + number - 1 + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
function monthsBetween(first, last) {
  const months = [];
  for (let month = first; month <= last; month = shift(month, 1)) months.push(month);
  return months;
}

/** A seeded month: a steady pattern by its index, so every range has figures. */
function seededMonth(month) {
  const n = Number(month.slice(5)) + Number(month.slice(0, 4)) % 7;
  const started = 2 + (n % 4);
  return {
    projects_started: started,
    with: { personas: started, research: Math.max(0, started - 2), prfaq: started - 1, prd: Math.max(0, started - 1),
      prototype: Math.max(0, started - 2), validation: Math.max(0, started - 3) },
    artifacts: { personas: { ai: 3 * started, human: 1 }, research: { ai: started - 1, human: 0 },
      prfaq: { ai: started - 1, human: 1 }, prd: { ai: Math.max(0, started - 2), human: 1 }, prototype: { ai: started, human: 0 } },
    decisions: { pursue: n % 3, park: 1, reject: n % 2 },
    validated_decisions: n % 2,
    validation_reports: Math.max(0, started - 3),
    validation_runs: { real: 0, synthetic: n % 3 },
    cycle_days: { evidence_to_prd: { [String(6 + (n % 5))]: 2 }, prd_to_prototype: { [String(3 + (n % 4))]: 1 },
      prototype_to_decision: { [String(9 + (n % 6))]: 1 } },
    assistant_conversations: 10 + 3 * n,
    agent_runs: n % 4,
  };
}

const hoursOf = () => Object.fromEntries(TYPES.map((type) => [type, settings.baselines[type] ?? DEFAULTS[type]]));
const baselines = () => Object.fromEntries(TYPES.map((type) => [type,
  { hours: settings.baselines[type] ?? DEFAULTS[type], saved: type in settings.baselines }]));

function median(histogram) {
  const values = Object.entries(histogram).flatMap(([days, count]) => Array(count).fill(Number(days))).sort((a, b) => a - b);
  if (values.length === 0) return null;
  const middle = values.length / 2;
  return values.length % 2 ? values[Math.floor(middle)] : (values[middle - 1] + values[middle]) / 2;
}

function periodView(period, months) {
  const buckets = months.map(seededMonth);
  const sum = (pick) => buckets.reduce((total, bucket) => total + pick(bucket), 0);
  const started = sum((b) => b.projects_started);
  const withSteps = Object.fromEntries(STEPS.map((step) => [step, sum((b) => b.with[step])]));
  const artifacts = Object.fromEntries(TYPES.map((type) => [type,
    { ai: sum((b) => b.artifacts[type].ai), human: sum((b) => b.artifacts[type].human) }]));
  const decisions = { pursue: sum((b) => b.decisions.pursue), park: sum((b) => b.decisions.park), reject: sum((b) => b.decisions.reject) };
  const hours = hoursOf();
  const cycles = Object.fromEntries(CYCLES.map((cycle) => {
    const merged = {};
    for (const bucket of buckets) {
      for (const [days, count] of Object.entries(bucket.cycle_days[cycle])) merged[days] = (merged[days] ?? 0) + count;
    }
    return [cycle, { median: median(merged), n: Object.values(merged).reduce((a, b) => a + b, 0) }];
  }));
  return {
    period, months, projects_started: started, with: withSteps,
    prototype_rate: started ? Math.round((withSteps.prototype / started) * 1000) / 1000 : null,
    artifacts, decisions: { ...decisions, total: decisions.pursue + decisions.park + decisions.reject },
    validated_decisions: sum((b) => b.validated_decisions), validation_reports: sum((b) => b.validation_reports),
    validation_runs: { real: 0, synthetic: sum((b) => b.validation_runs.synthetic) }, cycle_days: cycles,
    assistant_conversations: sum((b) => b.assistant_conversations), agent_runs: sum((b) => b.agent_runs),
    time_saved_hours: Math.round(TYPES.reduce((total, type) => total + artifacts[type].ai * hours[type], 0) * 10) / 10,
  };
}

/** parse_range: the months and grain of `?from=&to=&grain=`, or a refusal message. */
function rangeOf(params, now) {
  const grain = params.get('grain') || 'month';
  if (!['month', 'quarter'].includes(grain)) return { error: 'grain must be one of: month, quarter' };
  const current = monthOf(now);
  const read = (name) => {
    const raw = params.get(name);
    if (!raw) return null;
    return /^\d{4}-\d{2}(-\d{2})?$/.test(raw) ? raw.slice(0, 7) : undefined;
  };
  const to = read('to') ?? current;
  const from = read('from') ?? shift(to, -5);
  if (to === undefined) return { error: 'to must be a month (YYYY-MM) or a day (YYYY-MM-DD)' };
  if (from === undefined) return { error: 'from must be a month (YYYY-MM) or a day (YYYY-MM-DD)' };
  if (to > current) return { error: 'to must not be after the current month (UTC)' };
  if (from > to) return { error: 'from must not be after to' };
  const quarterStart = (month) => `${month.slice(0, 4)}-${String(Math.floor((Number(month.slice(5)) - 1) / 3) * 3 + 1).padStart(2, '0')}`;
  const first = grain === 'quarter' ? quarterStart(from) : from;
  const lastQuarter = shift(quarterStart(to), 2);
  const quarterEnd = lastQuarter > current ? current : lastQuarter;
  const last = grain === 'quarter' ? quarterEnd : to;
  const months = monthsBetween(first, last);
  if (months.length > 24) return { error: 'A range covers at most 24 months' };
  return { months, grain };
}

/** The months grouped by quarter (`YYYY-Qn`), in order. */
function byQuarter(months) {
  const quarters = {};
  for (const month of months) {
    const label = `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5)) - 1) / 3) + 1}`;
    quarters[label] = [...(quarters[label] ?? []), month];
  }
  return quarters;
}

function view(params) {
  const now = new Date();
  const range = rangeOf(params, now);
  if (range.error) return [400, { success: false, error: range.error }];
  const periods = range.grain === 'month'
    ? range.months.map((month) => periodView(month, [month]))
    : Object.entries(byQuarter(range.months)).map(([label, months]) => periodView(label, months));
  const asOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 5)).toISOString();
  return [200, {
    scope: 'deployment', grain: range.grain, from: range.months[0], to: range.months.at(-1), as_of: asOf,
    complete: true, covered_from: shift(monthOf(now), -23), agent_runs_counted: true, periods,
    totals: periodView('total', range.months),
    time_saved: { estimate: true, label: LABEL, unit: 'hours', baselines: baselines(), note: settings.note,
      updated_at: settings.updated_at, assumptions: ASSUMPTIONS },
  }];
}

const settingsView = () => ({ baselines: baselines(), defaults: { ...DEFAULTS }, note: settings.note,
  updated_at: settings.updated_at, max_hours: MAX_HOURS, max_note_chars: MAX_NOTE });

/** The baselines a body sets, applied to `into`; the refusal message, else null. */
function mergedBaselines(given, into) {
  const entries = Object.entries(given ?? {});
  if (typeof given !== 'object' || entries.length === 0) return `baselines must map at least one of: ${TYPES.join(', ')} to hours`;
  for (const [type, value] of entries) {
    if (!TYPES.includes(type)) return `Unknown artifact type(s): ${type}`;
    if (value === null) { delete into[type]; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_HOURS) {
      return `baselines.${type} must be between 0 and ${MAX_HOURS} hours`;
    }
    into[type] = Math.round(value * 100) / 100;
  }
  return null;
}

/** The note a body sets, applied to `into`; the refusal message, else null. */
function mergedNote(note, into) {
  if (note !== null && typeof note !== 'string') return 'note must be text, or null';
  const text = (note ?? '').trim();
  if (text.length > MAX_NOTE) return `note must be at most ${MAX_NOTE} characters`;
  into.note = text || null;
  return null;
}

/** validate_changes and merged_config: the next settings, or a refusal message. */
function merged(body) {
  const given = Object.keys(body ?? {});
  const unknown = given.filter((key) => !['baselines', 'note'].includes(key));
  if (unknown.length > 0) return { error: `Unknown field(s): ${unknown.sort().join(', ')}` };
  if (given.length === 0) return { error: 'Give at least one of: baselines, note' };
  const next = { baselines: { ...settings.baselines }, note: settings.note };
  const error = ('baselines' in body ? mergedBaselines(body.baselines, next.baselines) : null)
    ?? ('note' in body ? mergedNote(body.note, next) : null);
  return error === null ? { next } : { error };
}

/** Handle `/metrics/adoption` and `/settings/adoption`; returns true when the request was taken. */
export function handleAdoptionRoutes(req, res, url, send, shared) {
  if (url.pathname === VIEW) {
    if (req.method !== 'GET') { send(405, { success: false, error: 'Method not allowed' }); return true; }
    const [status, body] = view(url.searchParams);
    send(status, body);
    return true;
  }
  if (url.pathname !== SETTINGS) return false;
  if (req.method === 'GET') { send(200, settingsView()); return true; }
  if (req.method !== 'PUT') { send(405, { success: false, error: 'Method not allowed' }); return true; }
  shared.collectJson(req, res, (body) => {
    const { next, error } = merged(body);
    if (error) { send(400, { success: false, error }); return; }
    Object.assign(settings, next, { updated_at: new Date().toISOString() });
    send(200, settingsView());
  });
  return true;
}
