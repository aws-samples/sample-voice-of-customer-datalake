// Prioritization SCORING SETUP mock (docs/prioritization.md): the workspace's configurable
// metrics, in the wire shapes of lambda/shared/prioritization_axes.py and the
// `/projects/prioritization/config` routes of projects_handler.py. Stateful for the life of
// the mock process. The mock caller is an admin, so PUT never answers 403 here.
//
// Owns GET/PUT /projects/prioritization/config (wired by handleDomainModules) and exports the
// helpers mock-server.js's ballot read/write uses, so ballots, aggregates and the public
// voting config all follow the stored setup.

import { readFileSync } from 'node:fs';

const DEFAULTS = JSON.parse(readFileSync(new URL('../schemas/prioritization-default-axes.json', import.meta.url), 'utf8'));
const CONFIG_ROUTE = '/projects/prioritization/config';
const BUILTIN_IDS = new Set(DEFAULTS.axes.map((axis) => axis.id));
const DIRECTIONS = new Set(['higher_better', 'lower_better']);
const AXIS_ID = /^[a-z][a-z0-9_]{1,31}$/;
// Never an axis id: the ballot record's own attributes (THE CONTRACT).
const RESERVED = new Set([
  'notes', 'row_id', 'reviewer', 'updated_at', 'voting_session', 'display_name', 'pk', 'sk', 'score', 'scores',
  'composite', 'ballot_id', 'session_id', 'document_id', 'created_at', 'anon_id', 'user', 'anon',
]);
const LIMITS = { label: 40, description: 160, scale: 24 };

const config = {
  axes: DEFAULTS.axes.map((axis) => ({ ...axis })),
  config_version: 0,
  updated_at: null,
  updated_by: null,
};

/** The axes people see, score and count, in the configured order. */
const activeAxes = () => config.axes.filter((axis) => !axis.archived);
export const activeAxisIds = () => activeAxes().map((axis) => axis.id);

/** `{axes, config_version}` for GET /projects/prioritization. */
export const axesPayload = () => ({ axes: config.axes.map((axis) => ({ ...axis })), config_version: config.config_version });

/** The public voting config's projection: active axes, no weights. */
export const publicAxes = () => activeAxes().map(({ id, label, description, low_label, high_label, direction, builtin }) => ({
  id, label, description, low_label, high_label, direction, builtin,
}));

/** THE CONTRACT composite: Σ w·v' / Σ w over the active axes this ballot scored; null when none. */
export function ballotComposite(ballot) {
  const sums = activeAxes().reduce((acc, axis) => {
    const value = ballot?.[axis.id];
    if (typeof value !== 'number' || value <= 0) return acc;
    const oriented = axis.direction === 'lower_better' ? 6 - value : value;
    return { weighted: acc.weighted + axis.weight * oriented, weight: acc.weight + axis.weight };
  }, { weighted: 0, weight: 0 });
  return sums.weight > 0 ? sums.weighted / sums.weight : null;
}

const fail = (error) => ({ error });

function cleanText(value, max, name) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return fail(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) return fail(`${name} must be at most ${max} characters`);
  return { value: trimmed === '' ? null : trimmed };
}

/** shared/prioritization_axes.mint_slug: from the label, never reserved, unique (`_2`, …). */
function mintSlug(label, taken) {
  const base = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]/).filter(Boolean).join('_').slice(0, 28) || 'metric';
  const start = /^[a-z]/.test(base) && base.length >= 2 ? base : `m_${base}`.slice(0, 28);
  const free = (candidate) => !taken.has(candidate) && !RESERVED.has(candidate) && AXIS_ID.test(candidate);
  if (free(start)) return start;
  // A setup holds at most 20 metrics, so a free suffix is always among the first 21.
  return Array.from({ length: DEFAULTS.max_axes + 1 }, (_, i) => `${start}_${i + 2}`).find(free) ?? `${start}_x`;
}

function readTexts(input, builtin) {
  const label = cleanText(input.label, LIMITS.label, 'label');
  const description = cleanText(input.description, LIMITS.description, 'description');
  const low = cleanText(input.low_label, LIMITS.scale, 'low_label');
  const high = cleanText(input.high_label, LIMITS.scale, 'high_label');
  const failed = [label, description, low, high].find((field) => field.error);
  if (failed) return failed;
  if (!builtin && label.value === null) return fail('Every metric needs a name');
  return { label: label.value, description: description.value, low_label: low.value, high_label: high.value };
}

function readAxis(input, taken) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('Each metric must be an object');
  const known = config.axes.find((axis) => axis.id === input.id);
  if (input.id !== undefined && !known && !BUILTIN_IDS.has(input.id)) return fail(`Unknown metric: ${String(input.id)}`);
  const builtin = BUILTIN_IDS.has(input.id);
  const texts = readTexts(input, builtin);
  if (texts.error) return texts;
  if (!Number.isInteger(input.weight) || input.weight < 0 || input.weight > 100) return fail('Weight must be a whole number from 0 to 100');
  if (!DIRECTIONS.has(input.direction)) return fail('Direction must be higher_better or lower_better');
  const id = input.id ?? mintSlug(texts.label, taken);
  taken.add(id);
  return { axis: { id, builtin, ...texts, weight: input.weight, direction: input.direction, archived: input.archived === true } };
}

function setupError(axes) {
  const active = axes.filter((axis) => !axis.archived);
  if (axes.length > DEFAULTS.max_axes) return `A setup holds at most ${DEFAULTS.max_axes} metrics`;
  if (active.length < 1 || active.length > DEFAULTS.max_active_axes) return `Use 1 to ${DEFAULTS.max_active_axes} active metrics`;
  if (!active.some((axis) => axis.weight > 0)) return 'At least one active metric needs a weight above 0';
  const dropped = config.axes.find((stored) => !axes.some((axis) => axis.id === stored.id));
  return dropped ? `Metric ${dropped.id} cannot be removed — archive it instead` : null;
}

function saveConfig(body) {
  if (!Array.isArray(body?.axes)) return [400, { success: false, error: 'axes must be a list' }];
  if (!Number.isInteger(body?.base_version)) return [400, { success: false, error: 'base_version is required' }];
  if (body.base_version !== config.config_version) {
    return [409, { success: false, error: 'Someone else changed the scoring setup; reload it and try again' }];
  }
  const taken = new Set(body.axes.map((input) => input?.id).filter((id) => typeof id === 'string'));
  const parsed = body.axes.map((input) => readAxis(input, taken));
  const failed = parsed.find((entry) => entry.error);
  if (failed) return [400, { success: false, error: failed.error }];
  const axes = parsed.map((entry) => entry.axis);
  const problem = setupError(axes);
  if (problem) return [400, { success: false, error: problem }];
  Object.assign(config, {
    axes, config_version: config.config_version + 1, updated_at: new Date().toISOString(), updated_by: 'admin-demo',
  });
  return [200, { success: true, ...config, axes: config.axes.map((axis) => ({ ...axis })) }];
}

/**
 * A ballot's axis fields, refused like ballots_handler / projects_handler: an id that is not
 * an ACTIVE axis → error. `skip` lists the record's own non-axis fields.
 */
export function unknownAxisField(entry, skip) {
  const active = new Set(activeAxisIds());
  return Object.keys(entry ?? {}).find((key) => !skip.has(key) && !active.has(key)) ?? null;
}

export function handlePrioritizationConfigRoutes(req, res, url, send, shared) {
  if (url.pathname !== CONFIG_ROUTE) return false;
  if (req.method === 'GET') {
    send(200, { success: true, ...config, axes: config.axes.map((axis) => ({ ...axis })) });
    return true;
  }
  if (req.method === 'PUT') {
    shared.collectJson(req, res, (body) => {
      const [status, payload] = saveConfig(body);
      send(status, payload);
    });
    return true;
  }
  send(405, { success: false, error: 'Method not allowed' });
  return true;
}
