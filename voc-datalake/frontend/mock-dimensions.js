// Dimensions, tags, source profiles and erasure mock, in the wire shapes of the
// KVD contract (shared/dimension_config.py, shared/source_profiles.py,
// settings_handler / metrics_handler / feedback_edit_handler):
//
//   GET|PUT /settings/dimensions        {dimensions, updated_at} / {success, dimensions}
//   GET|PUT /settings/sources           {sources} / {success, sources}  (the mock caller is an admin)
//   GET|POST /settings/erasure          {jobs} / 202 {job}  (only the value's sha256 is kept)
//   GET /metrics/dimensions?key=…       {key, period_days, is_partial, values, unassigned}
//   PUT /feedback/{id}/dimensions       {success, feedback_id, dimensions, tags}
//
// Stateful for the life of the process. The fixtures: `product` with a child
// `module` (parent link + parent_value), `user_type`; profiles including a
// restricted `support_tickets` (pii redact, retention 365). Fixture feedback is
// stamped by seedDimensionFixtures so filters and chips have data in dev.
// The `channel` / `dims` / `tag` filters and the entities additions are shared
// with mock-server.js through attributeFilterOf / entityExtras.
// Wired into mock-server.js by handleDomainModules.

import { createHash, randomBytes } from 'node:crypto';

const MAX_DIMENSIONS = 10;
const MAX_VALUES = 200;
const MAX_PROFILES = 50;
const MAX_TAGS = 20;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const VALUE_RE = /^[^\s#,:]{1,64}$/;
const TAG_RE = /^[^\s#,:][^#,:\p{Cc}]{0,63}$/u;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const RESERVED = new Set(['category', 'subcategory', 'source', 'channel', 'tag', 'tags', 'sentiment', 'urgency', 'days', 'limit', 'offset', 'q']);
const PII = ['allow', 'redact', 'summary_only'];
const ERASURE_FIELDS = ['author', 'source_id', 'csv_row_id', 'email'];
const SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'];
const CALLER = 'admin-demo';

const now = () => new Date().toISOString();

const state = {
  dimensions: [
    {
      key: 'product', label: 'Product', description: 'Which product the feedback is about', infer: true,
      values: [
        { name: 'mobile_app', label: 'Mobile app' },
        { name: 'web_shop', label: 'Web shop' },
        { name: 'partner_portal', label: 'Partner portal' },
      ],
    },
    {
      key: 'module', label: 'Module', infer: true, parent: 'product',
      values: [
        { name: 'login', label: 'Login', parent_value: 'mobile_app' },
        { name: 'push_notifications', label: 'Push notifications', parent_value: 'mobile_app' },
        { name: 'checkout', label: 'Checkout', parent_value: 'web_shop' },
        { name: 'search', label: 'Search' },
        { name: 'invoicing', label: 'Invoicing', parent_value: 'partner_portal' },
      ],
    },
    {
      key: 'user_type', label: 'User type', description: 'Who wrote it', infer: false,
      values: [{ name: 'customer', label: 'Customer' }, { name: 'partner', label: 'Partner' }],
    },
  ],
  dimensionsUpdatedAt: now(),
  sources: [
    { id: 'webscraper', label: 'Web scraper', pii: 'allow', retention_days: null, restricted: false, dimension_defaults: {}, tags: [] },
    { id: 'manual_import', label: 'Manual import', pii: 'allow', retention_days: null, restricted: false, dimension_defaults: {}, tags: [] },
    { id: 'feedback_form', label: 'Feedback forms', pii: 'allow', retention_days: null, restricted: false, dimension_defaults: { user_type: 'customer' }, tags: [] },
    { id: 'sales_csv', label: 'Sales CSV', pii: 'allow', retention_days: null, restricted: false, dimension_defaults: { user_type: 'partner' }, tags: ['sales'] },
    { id: 'support_tickets', label: 'Support tickets', pii: 'redact', retention_days: 365, restricted: true, dimension_defaults: {}, tags: ['support'] },
  ],
  erasureJobs: [], // newest first
};

// ── Fixtures on the shared feedback ──────────────────────────────────────────

const SEED = {
  1: { dimensions: { product: 'web_shop', module: 'checkout', user_type: 'customer' }, sources: { product: 'ai', module: 'ai', user_type: 'profile' }, tags: ['delivery_delay'], author: 'Jordan P.' },
  2: { dimensions: { product: 'mobile_app', module: 'login' }, sources: { product: 'source', module: 'manual' }, tags: ['vip', 'support'] },
  3: { dimensions: { product: 'partner_portal', user_type: 'partner' }, sources: { product: 'category', user_type: 'profile' }, tags: ['sales'], pii_policy: 'redact' },
  4: { dimensions: { product: 'mobile_app' }, sources: { product: 'ai' }, pii_policy: 'summary_only' },
};

/** Stamp the first fixture items with dimensions / tags / a policy (once, at startup). */
export function seedDimensionFixtures(feedback) {
  for (const item of feedback) {
    const seed = SEED[item.feedback_id];
    if (!seed) continue;
    item.dimensions = { ...seed.dimensions };
    item.dimension_sources = { ...seed.sources };
    if (seed.tags) item.tags = [...seed.tags];
    if (seed.author) item.author = seed.author;
    if (seed.pii_policy) item.pii_policy = seed.pii_policy;
  }
}

export const sourceProfiles = () => state.sources;
export const dimensionsConfig = () => state.dimensions;

// ── Validation (the client-safe messages of the real validators) ─────────────

function validateValue(value, dimension, parent) {
  if (!value || typeof value.name !== 'string' || !VALUE_RE.test(value.name)) return `Invalid value name in "${dimension.key}"`;
  if (value.parent_value !== undefined && !(parent?.values || []).some((v) => v.name === value.parent_value)) {
    return `Value "${value.name}" names a parent_value that is not in "${dimension.parent}"`;
  }
  return null;
}

function validateDimension(dimension, byKey) {
  if (!dimension || typeof dimension.key !== 'string' || !KEY_RE.test(dimension.key)) return 'Dimension keys must be lowercase snake_case';
  if (RESERVED.has(dimension.key)) return `"${dimension.key}" is a reserved name`;
  if (!Array.isArray(dimension.values) || dimension.values.length > MAX_VALUES) return `At most ${MAX_VALUES} values per dimension`;
  const parent = dimension.parent === undefined ? undefined : byKey.get(dimension.parent);
  if (dimension.parent !== undefined && (!parent || parent.parent !== undefined || parent.key === dimension.key)) {
    return `"${dimension.key}" must name another top-level dimension as its parent`;
  }
  const names = new Set();
  for (const value of dimension.values) {
    const error = validateValue(value, dimension, parent);
    if (error) return error;
    if (names.has(value.name)) return `Duplicate value "${value.name}" in "${dimension.key}"`;
    names.add(value.name);
  }
  return null;
}

function validateDimensions(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length > MAX_DIMENSIONS) return `At most ${MAX_DIMENSIONS} dimensions`;
  const byKey = new Map(dimensions.filter((d) => d && typeof d.key === 'string').map((d) => [d.key, d]));
  if (byKey.size !== dimensions.length) return 'Dimension keys must be unique';
  for (const dimension of dimensions) {
    const error = validateDimension(dimension, byKey);
    if (error) return error;
  }
  return null;
}

function validTags(tags) {
  return Array.isArray(tags) && tags.length <= MAX_TAGS && tags.every((t) => typeof t === 'string' && TAG_RE.test(t.trim()));
}

function resolves(key, value) {
  const dimension = state.dimensions.find((d) => d.key === key);
  return Boolean(dimension && dimension.values.some((v) => v.name === value));
}

function validateProfile(profile, ids) {
  if (!profile || typeof profile.id !== 'string' || !SOURCE_ID_RE.test(profile.id)) return 'Source ids must be lowercase letters, digits, "_" or "-"';
  if (ids.has(profile.id)) return `Duplicate source id "${profile.id}"`;
  ids.add(profile.id);
  if (!PII.includes(profile.pii ?? 'allow')) return 'pii must be allow, redact or summary_only';
  const days = profile.retention_days ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 30 || days > 3650)) return 'retention_days must be null or 30-3650';
  const defaults = profile.dimension_defaults ?? {};
  if (Object.entries(defaults).some(([key, value]) => !resolves(key, value))) return `Unknown dimension default on "${profile.id}"`;
  if (!validTags(profile.tags ?? [])) return `Invalid tags on "${profile.id}"`;
  return null;
}

function normalizedProfile(p) {
  return {
    id: p.id, label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : p.id,
    pii: p.pii ?? 'allow', retention_days: p.retention_days ?? null, restricted: p.restricted === true,
    dimension_defaults: { ...(p.dimension_defaults ?? {}) }, tags: [...(p.tags ?? [])],
  };
}

// ── Filters shared with mock-server.js (/feedback, /urgent, /search, /entities, /metrics/*) ──

/**
 * The `channel` / `dims` / `tag` filter of a request as a predicate, or
 * `{error}` for a malformed `dims` (the real routes answer 400).
 */
export function attributeFilterOf(searchParams) {
  const channel = searchParams?.get('channel') || '';
  const tag = (searchParams?.get('tag') || '').toLowerCase();
  const rawDims = searchParams?.get('dims') || '';
  const pairs = rawDims ? rawDims.split(',').map((pair) => pair.split(':')) : [];
  if (pairs.length > MAX_DIMENSIONS || pairs.some((p) => p.length !== 2 || !KEY_RE.test(p[0]) || !VALUE_RE.test(p[1]))) {
    return { error: 'dims must be key:value pairs separated by commas' };
  }
  return {
    admits: (item) => (!channel || item.source_channel === channel)
      && (!tag || (item.tags || []).some((t) => t.toLowerCase() === tag))
      && pairs.every(([key, value]) => (item.dimensions || {})[key] === value),
  };
}

const countBy = (items, values) => items.reduce((acc, item) => {
  for (const value of values(item)) if (value) acc[value] = (acc[value] || 0) + 1;
  return acc;
}, {});

/** The contract's entities additions: channels, top-50 tags, dimensions. */
export function entityExtras(items) {
  const tags = Object.entries(countBy(items, (i) => i.tags || []))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50);
  const dimensions = Object.fromEntries(state.dimensions.map((d) => [d.key, countBy(items, (i) => [(i.dimensions || {})[d.key]])]));
  return { channels: countBy(items, (i) => [i.source_channel]), tags: Object.fromEntries(tags), dimensions };
}

// ── Routes ──────────────────────────────────────────────────────────────────

function putDimensions(body) {
  const error = validateDimensions(body?.dimensions);
  if (error) return [400, { success: false, error }];
  state.dimensions = body.dimensions.map((d) => ({ ...d, infer: d.infer !== false, values: d.values.map((v) => ({ ...v })) }));
  state.dimensionsUpdatedAt = now();
  return [200, { success: true, dimensions: state.dimensions }];
}

function putSources(body) {
  const sources = body?.sources;
  if (!Array.isArray(sources) || sources.length > MAX_PROFILES) return [400, { success: false, error: `At most ${MAX_PROFILES} source profiles` }];
  const ids = new Set();
  for (const profile of sources) {
    const error = validateProfile(profile, ids);
    if (error) return [400, { success: false, error }];
  }
  state.sources = sources.map(normalizedProfile);
  return [200, { success: true, sources: state.sources }];
}

/** A poll moves a live job one step: queued → running → completed. */
function advanceErasure(job, shared) {
  if (job.status === 'queued') job.status = 'running';
  else if (job.status === 'running') {
    job.deleted_items = shared.mockFeedback.filter((f) => f.author && job.value_hash === sha256(f.author)).length;
    job.deleted_objects = job.deleted_items;
    job.status = 'completed';
    job.finished_at = now();
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function startErasure(body) {
  const field = body?.field;
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (!ERASURE_FIELDS.includes(field) || !value || value.length > 512) {
    return [400, { success: false, error: 'field must be author, source_id, csv_row_id or email, with a value' }];
  }
  const source = typeof body.source === 'string' && body.source !== '' ? body.source : undefined;
  if (source && !state.sources.some((p) => p.id === source)) return [400, { success: false, error: 'Unknown source' }];
  if (!source && (field === 'source_id' || field === 'csv_row_id')) {
    return [400, { success: false, error: `source is required when field is ${field}` }];
  }
  const job = {
    job_id: `er_${randomHex()}`, status: 'queued', field, source, value_hash: sha256(value),
    deleted_items: 0, deleted_objects: 0, started_by: CALLER, created_at: now(),
  };
  if (!source) delete job.source;
  state.erasureJobs.unshift(job);
  return [202, { job }];
}

const randomHex = () => randomBytes(6).toString('hex');

function dimensionMetrics(url, shared) {
  const key = url.searchParams.get('key') || '';
  const dimension = state.dimensions.find((d) => d.key === key);
  if (!dimension) return [400, { success: false, error: 'key must name a configured dimension' }];
  const filter = attributeFilterOf(url.searchParams);
  if (filter.error) return [400, { success: false, error: filter.error }];
  const source = url.searchParams.get('source') || '';
  const items = shared.mockFeedback.filter((f) => (!source || f.source_platform === source) && filter.admits(f));
  const values = {};
  let unassigned = 0;
  for (const item of items) {
    const value = (item.dimensions || {})[key];
    if (!value) { unassigned += 1; continue; }
    const bucket = values[value] ?? (values[value] = { count: 0, positive: 0, negative: 0, neutral: 0, mixed: 0 });
    bucket.count += 1;
    if (SENTIMENTS.includes(item.sentiment_label)) bucket[item.sentiment_label] += 1;
  }
  return [200, { key, period_days: Number(url.searchParams.get('days')) || 7, is_partial: false, values, unassigned }];
}

function editFeedbackDimensions(id, body, shared) {
  const item = shared.mockFeedback.find((f) => f.feedback_id === id);
  if (!item) return [404, { success: false, error: 'Not found' }];
  const changes = body?.dimensions ?? {};
  if (typeof changes !== 'object' || Array.isArray(changes)) return [400, { success: false, error: 'dimensions must be an object' }];
  for (const [key, value] of Object.entries(changes)) {
    if (value !== null && !resolves(key, value)) return [400, { success: false, error: `Unknown value for "${key}"` }];
  }
  if (body?.tags !== undefined && !validTags(body.tags)) return [400, { success: false, error: 'Invalid tags' }];
  const dimensions = { ...(item.dimensions || {}) };
  const sources = { ...(item.dimension_sources || {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) { delete dimensions[key]; delete sources[key]; } else { dimensions[key] = value; sources[key] = 'manual'; }
  }
  item.dimensions = dimensions;
  item.dimension_sources = sources;
  if (body?.tags !== undefined) item.tags = [...new Set(body.tags.map((t) => t.trim()))];
  return [200, { success: true, feedback_id: id, dimensions, tags: item.tags || [] }];
}

function route(req, url, body, shared) {
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case 'GET /settings/dimensions': return [200, { dimensions: state.dimensions, updated_at: state.dimensionsUpdatedAt }];
    case 'PUT /settings/dimensions': return putDimensions(body);
    case 'GET /settings/sources': return [200, { sources: state.sources }];
    case 'PUT /settings/sources': return putSources(body);
    case 'POST /settings/erasure': return startErasure(body);
    case 'GET /settings/erasure':
      state.erasureJobs.forEach((job) => advanceErasure(job, shared));
      return [200, { jobs: state.erasureJobs.slice(0, 20) }];
    case 'GET /metrics/dimensions': return dimensionMetrics(url, shared);
    default: break;
  }
  const edit = url.pathname.match(/^\/feedback\/([^/]+)\/dimensions$/);
  if (edit && req.method === 'PUT') return editFeedbackDimensions(decodeURIComponent(edit[1]), body, shared);
  return [405, { success: false, error: 'Method not allowed' }];
}

const ROUTE = /^\/(settings\/(dimensions|sources|erasure)|metrics\/dimensions|feedback\/[^/]+\/dimensions)$/;

/** Handle this module's routes; returns true when the request was taken. */
export function handleDimensionRoutes(req, res, url, send, shared) {
  if (!ROUTE.test(url.pathname)) return false;
  shared.collectJson(req, res, (body) => {
    const [status, payload] = route(req, url, body, shared);
    send(status, payload);
  });
  return true;
}
