// Data-source mocks for local dev: logs, feedback search, source schedules and
// runs, AI category generation, integration credentials, web scrapers, manual
// import, the S3 import drop bucket and the Data Explorer writes. Wire shapes
// follow lambda/api/logs_handler.py, metrics_handler.py (/feedback/search),
// integrations_handler.py, settings_handler.py (/settings/categories/generate),
// scrapers_handler.py, manual_import_handler.py, s3_import_handler.py and
// data_explorer_handler.py; errors use their {success: false, error} envelope
// (lambda/shared/api.py). Stateful for the life of the mock process. The mock
// caller is an admin, so admin-gated routes answer as they would for one.
// Wired into mock-server.js by handleDomainModules, which runs this BEFORE every
// other route: handleSourceRoutes claims only the method + path pairs in ROUTES.

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const DAY_MS = 86_400_000;
/** How long a mock scraper / source run stays 'running' before it completes. */
const RUN_DURATION_MS = 3000;
/** GET polls a manual-parse job answers 'processing' before 'completed'. */
const PARSE_POLLS_BEFORE_DONE = 1;
const MOCK_RAW_BUCKET = 'voc-raw-data-123456789012-us-west-2';
const MOCK_S3_IMPORT_BUCKET = 'voc-s3-import-123456789012-us-west-2';

// ── Small pure helpers ───────────────────────────────────────────────────────

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const fail = (status, error) => [status, { success: false, error }];
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

/** `YYYYmmddHHMMSS`, the suffix the real handlers put on an execution id. */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** `raw/{source}/{yyyy}/{mm}/{dd}/{name}`, the partitioned data-lake key. */
function rawKey(source, name, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `raw/${source}/${date.getUTCFullYear()}/${p(date.getUTCMonth() + 1)}/${p(date.getUTCDate())}/${name}`;
}

/** Python's `int(x)` on a query param: the default when absent or unreadable. */
function intParam(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Copy only `fields` that `source` owns into a null-prototype object. */
function pick(source, fields) {
  const out = Object.create(null);
  for (const field of fields) {
    if (Object.hasOwn(source, field)) out[field] = source[field];
  }
  return out;
}

const later = (fn) => setTimeout(fn, RUN_DURATION_MS).unref();

// Mirrors shared/plugin_identity.py.
const PLUGIN_IDENTIFIER_RE = /^[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?$/;
const PLUGIN_IDENTIFIER_RULES = 'must contain only lowercase letters, digits, and underscores, must start '
  + 'and end with a letter or digit, and must be 1 to 64 characters long';
// The plugin ids CDK hands integrations_handler (PLUGIN_SECRET_DEFAULTS), with
// the defaults it seeded: a value equal to its seed counts as "not configured".
const PLUGIN_SEEDS = {
  webscraper: { configs: '[]' },
  s3_import: { bucket_name: '', import_prefix: 'imports/', processed_prefix: 'processed/' },
  synthetic_reviews: { company_name: '', product_name: '', num_reviews: '10', sentiment_mix: 'balanced', language: 'en' },
  github_issues: { repos: '', token: '', labels: '', webhook_secret: '' },
  app_reviews_ios: { app_name: '', app_id: '', sort_by: 'most_recent', max_reviews_per_run: '500', frequency_minutes: '1440' },
  app_reviews_android: { app_name: '', package_name: '', sort_by: 'most_recent', max_reviews_per_run: '500', frequency_minutes: '1440' },
};
const preview40 = (v) => `'${String(v).slice(0, 40)}'`;

/** integrations_handler._validate_source_parameter: form, then a known plugin. */
function sourceError(source) {
  if (!PLUGIN_IDENTIFIER_RE.test(source)) return `Invalid source identifier ${preview40(source)}: source ${PLUGIN_IDENTIFIER_RULES}.`;
  if (!Object.hasOwn(PLUGIN_SEEDS, source)) return `Unknown source identifier ${preview40(source)}: it is not a configured plugin.`;
  return null;
}

// ── Feedback written by the import routes ────────────────────────────────────
// The real routes enqueue to the processor, which writes the feedback table
// later. The mock "processes" at once so imported rows show up on the
// Dashboard and Categories pages in the same dev session.

const CATEGORY_HINTS = [
  [/deliver|shipping|shipped|arriv|courier/i, 'delivery'],
  [/price|expensive|cheap|cost|refund/i, 'pricing'],
  [/support|agent|service|help desk|answer/i, 'customer_support'],
  [/broke|defect|quality|stopped working|cracked/i, 'product_quality'],
  [/app\b|crash|login|update/i, 'app'],
];

function guessCategory(shared, text) {
  const configured = new Set(shared.mockCategoriesConfig.categories.map((c) => c.name));
  const hint = CATEGORY_HINTS.find(([re, name]) => re.test(text) && configured.has(name));
  return hint ? hint[1] : (shared.mockCategoriesConfig.categories[0]?.name ?? 'other');
}

function sentimentOf(rating) {
  if (typeof rating !== 'number') return ['neutral', 0];
  if (rating >= 4) return ['positive', 0.72];
  if (rating <= 2) return ['negative', -0.64];
  return ['neutral', 0.05];
}

/** A processed feedback item for one imported row; null fields omitted like the processor. */
function processImported(shared, row) {
  const [label, score] = sentimentOf(row.rating);
  const item = {
    feedback_id: shared.nextMockId('fb'),
    source_platform: row.source_platform,
    source_channel: row.source_channel,
    original_text: row.text,
    rating: row.rating,
    category: guessCategory(shared, row.text),
    sentiment_label: label,
    sentiment_score: score,
    urgency: label === 'negative' ? 'medium' : 'low',
    impact_area: 'cx',
    persona_type: 'existing_customer',
    source_url: row.url || undefined,
    title: row.title || undefined,
    author: row.author || undefined,
    dimensions: row.dimensions && Object.keys(row.dimensions).length ? row.dimensions : undefined,
    tags: row.tags?.length ? row.tags : undefined,
    metadata: row.metadata && Object.keys(row.metadata).length ? row.metadata : undefined,
    source_created_at: row.created_at || new Date().toISOString(),
    processed_at: new Date().toISOString(),
  };
  for (const key of Object.keys(item)) if (item[key] === undefined || item[key] === null) delete item[key];
  shared.mockFeedback.push(item);
  return item;
}

// ── Raw data lake objects (Data Explorer preview/save, import archives) ──────

const rawObjects = new Map(); // key -> { content, contentType, lastModified }

function putRawObject(_shared, key, content, contentType = 'application/json') {
  // GET /data-explorer/s3 lists this store directly, so a write shows up there.
  rawObjects.set(key, { content, contentType, lastModified: new Date().toISOString() });
}

function seedRawObjects() {
  const twoDays = new Date(Date.now() - 2 * DAY_MS);
  rawObjects.set(rawKey('webscraper', 'rev_8f2a1c.json', twoDays), {
    contentType: 'application/json', lastModified: twoDays.toISOString(),
    content: JSON.stringify({
      id: 'rev_8f2a1c', source_platform: 'webscraper', url: 'https://example.com/reviews?page=2',
      text: 'Checkout kept timing out on mobile. Third attempt finally worked.', rating: 2,
      author: 'J. Rivera', created_at: twoDays.toISOString(),
    }, null, 2),
  });
  rawObjects.set(rawKey('manual_import', 'job_seed.json', twoDays), {
    contentType: 'application/json', lastModified: twoDays.toISOString(),
    content: JSON.stringify({ job_id: 'job_seed', source_origin: 'g2', final_reviews: [{ text: 'Solid reporting, clunky exports.', rating: 4, date: '2026-07-01' }] }, null, 2),
  });
  // A plain-text object: the preview answers it as a string, not parsed JSON.
  rawObjects.set(rawKey('s3_import', 'notes.txt', twoDays), {
    contentType: 'text/plain', lastModified: twoDays.toISOString(), content: 'operator note: re-import of the June export',
  });
}
seedRawObjects();

// ── /logs/* (logs_handler.py) ────────────────────────────────────────────────

const KNOWN_LOG_SOURCES = ['webscraper', 'manual_import', 's3_import'];
const HOUR_MS = 3_600_000;

const validationLogs = [
  { source_platform: 'webscraper', message_id: 'msg_4c1e9a', timestamp: isoAgo(2 * HOUR_MS), log_type: 'validation_failure',
    errors: ['text: field required'], raw_preview: '{"id": "rev_51", "rating": 5, "author": "Sam"}' },
  { source_platform: 's3_import', message_id: 'msg_77d0b2', timestamp: isoAgo(26 * HOUR_MS), log_type: 'validation_failure',
    errors: ['created_at: invalid datetime format', 'rating: must be between 1 and 5'], raw_preview: 'id,text,rating,date\n9,"Great",7,yesterday' },
  // Sparse legacy row: written before raw_preview existed.
  { source_platform: 'webscraper', message_id: 'msg_0a9f11', timestamp: isoAgo(4 * DAY_MS), log_type: 'validation_failure', errors: ['text: string too short'] },
  // Not in the fan-out list: visible only with ?source=synthetic_reviews, as on the real route.
  { source_platform: 'synthetic_reviews', message_id: 'msg_5e3c08', timestamp: isoAgo(5 * HOUR_MS), log_type: 'validation_failure',
    errors: ['source_channel: field required'], raw_preview: '{"text": "Generated review"}' },
];
const processingLogs = [
  { source_platform: 'manual_import', message_id: 'msg_b81f40', timestamp: isoAgo(3 * HOUR_MS), log_type: 'processing_error',
    error_type: 'ThrottlingException', error_message: 'Bedrock rate exceeded; message returned to the queue for retry' },
  { source_platform: 'webscraper', message_id: 'msg_c2d7e5', timestamp: isoAgo(30 * HOUR_MS), log_type: 'processing_error',
    error_type: 'UnsupportedLanguage', error_message: 'Translate does not support detected language "la"' },
  { source_platform: 's3_import', message_id: 'msg_19aa3f', timestamp: isoAgo(9 * DAY_MS), log_type: 'processing_error',
    error_type: 'JSONDecodeError', error_message: 'Expecting value: line 1 column 1 (char 0)' },
];

function logsWithin(logs, source, days, limit) {
  const cutoff = Date.now() - days * DAY_MS;
  return logs
    .filter((log) => log.source_platform === source && Date.parse(log.timestamp) >= cutoff)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
    .map((log) => ({ ...log }));
}

function listLogs({ url }, logs) {
  const params = url.searchParams;
  const days = intParam(params, 'days', 7);
  const limit = Math.min(intParam(params, 'limit', 100), 500);
  const source = params.get('source');
  let found;
  if (source) {
    found = logsWithin(logs, source, days, limit);
  } else {
    const share = Math.floor(limit / KNOWN_LOG_SOURCES.length) + 1;
    found = KNOWN_LOG_SOURCES.flatMap((src) => logsWithin(logs, src, days, share))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }
  return [200, { logs: found, count: found.length, days }];
}

function logsSummary({ url }) {
  const days = intParam(url.searchParams, 'days', 7);
  const summary = { validation_failures: {}, processing_errors: {}, total_validation_failures: 0, total_processing_errors: 0 };
  for (const source of KNOWN_LOG_SOURCES) {
    const failures = logsWithin(validationLogs, source, days, 1000).length;
    const errors = logsWithin(processingLogs, source, days, 1000).length;
    if (failures) {
      summary.validation_failures[source] = failures;
      summary.total_validation_failures += failures;
    }
    if (errors) {
      summary.processing_errors[source] = errors;
      summary.total_processing_errors += errors;
    }
  }
  return [200, { summary, days }];
}

function clearValidationLogs(_ctx, source) {
  let deleted = 0;
  for (let i = validationLogs.length - 1; i >= 0; i -= 1) {
    if (validationLogs[i].source_platform === source) {
      validationLogs.splice(i, 1);
      deleted += 1;
    }
  }
  return [200, { success: true, deleted }];
}

// ── Scraper runs (SCRAPER_RUN#{id} rows; /runs, /logs/scraper, /status) ───────

const scraperRunHistory = new Map(); // scraper id -> run rows, newest first

/** The row list for `id`, seeded on first use from the shared latest-run record. */
function runHistory(shared, id) {
  if (scraperRunHistory.has(id)) return scraperRunHistory.get(id);
  const rows = [];
  const latest = shared.mockScraperRuns[id];
  if (latest) {
    rows.push({
      pk: `SCRAPER_RUN#${id}`, sk: latest.execution_id ?? `run_${id}_${stamp(new Date(Date.parse(latest.started_at) || Date.now()))}`,
      status: latest.status, started_at: latest.started_at, completed_at: latest.completed_at,
      pages_scraped: latest.pages_scraped ?? 0, items_found: latest.items_found ?? 0, errors: latest.errors ?? [],
    });
  }
  if (id === 'scraper_1') {
    const failedAt = new Date(Date.now() - 2 * DAY_MS);
    rows.push({
      pk: `SCRAPER_RUN#${id}`, sk: `run_${id}_${stamp(failedAt)}`, status: 'failed',
      started_at: failedAt.toISOString(), completed_at: new Date(failedAt.getTime() + 8000).toISOString(),
      pages_scraped: 1, items_found: 0, errors: ['HTTP 429 from example.com on page 2'],
    });
    // Sparse legacy row (pre-counters): /logs/scraper defaults its counts to 0 and errors to [].
    const legacyAt = new Date(Date.now() - 6 * DAY_MS);
    rows.push({ pk: `SCRAPER_RUN#${id}`, sk: `run_${id}_${stamp(legacyAt)}`, status: 'completed', started_at: legacyAt.toISOString() });
  }
  scraperRunHistory.set(id, rows);
  return rows;
}

/** get_scraper_status's view of one row — what the existing status route serves. */
const runStatusView = (id, row) => ({
  scraper_id: id, execution_id: row.sk, status: row.status, started_at: row.started_at,
  completed_at: row.completed_at, pages_scraped: row.pages_scraped ?? 0, items_found: row.items_found ?? 0, errors: row.errors ?? [],
});

function scraperLogs({ url, shared }, scraperId) {
  const days = intParam(url.searchParams, 'days', 7);
  const limit = Math.min(intParam(url.searchParams, 'limit', 50), 200);
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  const logs = runHistory(shared, scraperId).slice(0, limit)
    .filter((row) => !row.started_at || row.started_at >= cutoff)
    .map((row) => ({
      run_id: row.sk, status: row.status, started_at: row.started_at ?? '', completed_at: row.completed_at,
      pages_scraped: row.pages_scraped ?? 0, items_found: row.items_found ?? 0, errors: row.errors ?? [],
    }));
  return [200, { scraper_id: scraperId, logs, count: logs.length }];
}

function runScraper({ shared }, id) {
  const startedAt = new Date();
  const row = {
    pk: `SCRAPER_RUN#${id}`, sk: `run_${id}_${stamp(startedAt)}`, status: 'running',
    started_at: startedAt.toISOString(), pages_scraped: 0, items_found: 0, errors: [],
  };
  runHistory(shared, id).unshift(row);
  shared.mockScraperRuns[id] = runStatusView(id, row);
  later(() => {
    const config = shared.mockScrapers.find((s) => s.id === id);
    if (config && !config.base_url && (config.urls?.length ?? 0) <= 0) {
      Object.assign(row, { status: 'failed', errors: ['No URLs configured for this scraper'] });
    } else {
      const pages = config?.pagination?.enabled ? (config.pagination.max_pages ?? 1) : 1;
      // An unknown id is a run that finds nothing (scrapers_handler.run_scraper docstring).
      Object.assign(row, { status: 'completed', pages_scraped: config ? pages : 0, items_found: config ? pages * 9 : 0 });
    }
    row.completed_at = new Date().toISOString();
    shared.mockScraperRuns[id] = runStatusView(id, row);
  });
  return [200, { success: true, execution_id: row.sk, status: 'running' }];
}

function scraperRuns({ shared }, id) {
  return [200, { runs: runHistory(shared, id).slice(0, 10).map((row) => ({ ...row })) }];
}

function deleteScraper({ shared }, id) {
  const index = shared.mockScrapers.findIndex((s) => s.id === id);
  if (index >= 0) shared.mockScrapers.splice(index, 1);
  // Unknown ids succeed too: the real route rewrites the list without the id.
  return [200, { success: true }];
}

// Same two templates get_templates returns, plus a third for fixture variety.
// NOTE: like the backend, no `url_placeholder` and no top-level `pagination`.
const SCRAPER_TEMPLATES = [
  {
    id: 'review_jsonld', name: 'Review JSON-LD', description: 'Extract reviews using JSON-LD structured data.',
    icon: 'JSON-LD', extraction_method: 'jsonld', url_pattern: '', supports_pagination: true,
    config: { extraction_method: 'jsonld', template: 'review_jsonld', pagination: { enabled: true, param: 'page', max_pages: 10, start: 1 } },
  },
  {
    id: 'custom_css', name: 'Custom (CSS Selectors)', description: 'Create a custom scraper with CSS selectors.',
    icon: 'CSS', extraction_method: 'css', url_pattern: '', supports_pagination: true,
    config: { extraction_method: 'css', container_selector: '.review', text_selector: '.review-text', pagination: { enabled: false, param: 'page', max_pages: 10, start: 1 } },
  },
  {
    id: 'forum_threads', name: 'Forum Threads (CSS Selectors)', description: 'Community forum posts: one item per reply.',
    icon: 'CSS', extraction_method: 'css', url_pattern: '', supports_pagination: true,
    config: {
      extraction_method: 'css', container_selector: '.post', text_selector: '.post-content', author_selector: '.post-author',
      date_selector: 'time@datetime', pagination: { enabled: true, param: 'p', max_pages: 5, start: 1 },
    },
  },
];

// ── /scrapers/analyze-url (validate_url, then the model's selector guess) ────

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
const PRIVATE_ADDRESS_ERROR = 'Access to internal/private IP addresses is not allowed';

function isNonPublicIp(host) {
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const lower = host.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isNonPublicIp(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return false;
}

function urlError(raw) {
  if (!raw || typeof raw !== 'string') return 'URL is required';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Invalid URL format';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only http and https URLs are allowed';
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'URL must have a valid hostname';
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) return 'Access to localhost is not allowed';
  if (isNonPublicIp(host)) return PRIVATE_ADDRESS_ERROR;
  if (host.endsWith('.invalid') || host.endsWith('.test')) return 'Could not resolve hostname';
  return null;
}

const SELECTOR_GUESSES = [
  { container_selector: 'article.review', text_selector: '.review-body p', rating_selector: '.star-rating', author_selector: '.reviewer-name', date_selector: 'time.review-date', confidence: 'high', detected_reviews_count: 20 },
  { container_selector: 'div[data-hook="review"]', text_selector: 'span[data-hook="review-body"]', rating_selector: 'i[data-hook="review-star-rating"]', author_selector: '.a-profile-name', date_selector: 'span[data-hook="review-date"]', confidence: 'medium', detected_reviews_count: 10 },
  { container_selector: 'li.comment', text_selector: '.comment-text', rating_selector: '', author_selector: '.comment-author', date_selector: '.comment-meta time', confidence: 'low', detected_reviews_count: 4 },
];

function analyzeUrl(_ctx, body) {
  const error = urlError(body.url);
  if (error) return fail(400, error);
  const host = new URL(body.url).hostname;
  const index = [...host].reduce((n, ch) => n + ch.charCodeAt(0), 0) % SELECTOR_GUESSES.length;
  return [200, { success: true, selectors: { ...SELECTOR_GUESSES[index] } }];
}

// ── /feedback/search (metrics_handler.search_feedback) ───────────────────────

const SEARCH_QUERY_MIN_LENGTH = 2;

function tally(items, field, fallback) {
  const counts = {};
  for (const item of items) {
    const value = item[field] ?? fallback;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function searchFeedback({ url, shared }) {
  const params = url.searchParams;
  const query = str(params.get('q')).trim().toLowerCase();
  if (!query) return [200, { count: 0, items: [], entities: {}, query }];
  if (query.length < SEARCH_QUERY_MIN_LENGTH) {
    return fail(400, `Search query must be at least ${SEARCH_QUERY_MIN_LENGTH} characters after trimming; received ${query.length}.`);
  }
  const days = Math.min(Math.max(intParam(params, 'days', 30), 0), 9999);
  const limit = Math.min(Math.max(intParam(params, 'limit', 50), 1), 100);
  const reviewBasis = params.get('date_basis') === 'review';
  const cutoff = days === 0 ? -Infinity : Date.now() - days * DAY_MS;
  const [source, sentiment, category] = ['source', 'sentiment', 'category'].map((k) => params.get(k));
  const attributes = shared.attributeFilterOf(params);
  if (attributes.error) return fail(400, attributes.error);
  const items = shared.mockFeedback.filter((item) => {
    if (!attributes.admits(item)) return false;
    const date = reviewBasis ? (item.source_created_at ?? item.processed_at) : item.processed_at;
    if (Date.parse(date) < cutoff) return false;
    if (source && item.source_platform !== source) return false;
    if (sentiment && item.sentiment_label !== sentiment) return false;
    if (category && item.category !== category) return false;
    return [item.original_text, item.title, item.problem_summary].some((t) => str(t).toLowerCase().includes(query));
  }).slice(0, limit);
  return [200, {
    count: items.length,
    items,
    entities: {
      categories: tally(items, 'category', 'other'),
      sources: tally(items, 'source_platform', 'unknown'),
      sentiments: tally(items, 'sentiment_label', 'neutral'),
    },
    query,
    is_partial_window: false,
  }];
}

// ── /sources/* (integrations_handler: enable, disable, run) ──────────────────

// shared.mockSourcesStatus.sources is the record GET /sources/status answers,
// keyed by source ({enabled, schedule, rule_name, exists}).
function sourceEntry(shared, source) {
  const sources = shared.mockSourcesStatus.sources;
  if (!Object.hasOwn(sources, source)) {
    sources[source] = { enabled: false, schedule: 'rate(30 minutes)', rule_name: `voc-ingest-${source}-schedule`, exists: true };
  }
  return sources[source];
}

function toggleSource({ shared }, source, action) {
  const error = sourceError(source);
  if (error) return fail(400, error);
  const enabled = action === 'enable';
  sourceEntry(shared, source).enabled = enabled;
  return [200, { success: true, source, enabled }];
}

function runSource({ shared }, source) {
  const error = sourceError(source);
  if (error) return fail(400, error);
  const startedAt = new Date();
  const executionId = `run_${source}_${stamp(startedAt)}`;
  const record = { source, execution_id: executionId, status: 'running', started_at: startedAt.toISOString(), items_found: 0, errors: [] };
  shared.mockSourceRunStatuses[source] = record;
  later(() => {
    Object.assign(record, { status: 'completed', completed_at: new Date().toISOString(), items_found: source === 'synthetic_reviews' ? 5 : 12 });
  });
  return [200, { success: true, message: `Triggered ${source} ingestor`, source, execution_id: executionId }];
}

// ── /settings/categories/generate ────────────────────────────────────────────

const sub = (name, description) => ({ id: name, name, description });
const GENERATED_CATEGORIES = [
  { id: 'onboarding', name: 'onboarding', description: 'Onboarding & Setup', subcategories: [sub('account_creation', 'Account Creation'), sub('first_run', 'First-Run Experience'), sub('documentation', 'Documentation')] },
  { id: 'performance', name: 'performance', description: 'Performance & Reliability', subcategories: [sub('slowness', 'Slowness'), sub('outages', 'Outages'), sub('crashes', 'Crashes')] },
  { id: 'billing', name: 'billing', description: 'Billing & Pricing', subcategories: [sub('pricing_plans', 'Pricing Plans'), sub('invoices', 'Invoices'), sub('refunds', 'Refunds')] },
  { id: 'features', name: 'features', description: 'Feature Requests', subcategories: [sub('integrations', 'Integrations'), sub('reporting', 'Reporting'), sub('mobile', 'Mobile')] },
  { id: 'usability', name: 'usability', description: 'Usability', subcategories: [sub('navigation', 'Navigation'), sub('accessibility', 'Accessibility'), sub('visual_design', 'Visual Design')] },
  { id: 'support', name: 'support', description: 'Customer Support', subcategories: [sub('response_time', 'Response Time'), sub('resolution_quality', 'Resolution Quality'), sub('self_service', 'Self-Service')] },
];

function generateCategories(_ctx, body) {
  if (!str(body.company_description)) return fail(400, 'Company description is required');
  return [200, { success: true, categories: structuredClone(GENERATED_CATEGORIES) }];
}

// ── /integrations/* (status + credentials; /apps lives in mock-server.js) ────

const MAX_CREDENTIAL_KEYS_PER_REQUEST = 20;
// Stored secret values by plugin, keyed WITHOUT the `{source}_` prefix.
const credentials = new Map([
  ['synthetic_reviews', new Map([['company_name', 'Acme Retail'], ['product_name', 'Acme Go'], ['num_reviews', '10']])],
  ['github_issues', new Map([['repos', 'acme/storefront'], ['labels', 'bug,feedback']])],
]);
const storedFor = (source) => {
  if (!credentials.has(source)) credentials.set(source, new Map());
  return credentials.get(source);
};
const storedValue = (shared, source, key) => (source === 'webscraper' && key === 'configs' && !storedFor(source).has(key)
  ? JSON.stringify(shared.mockScrapers)
  : storedFor(source).get(key));

function isConfiguredValue(value, seed) {
  const text = str(value).trim();
  return !['', '[]', '{}'].includes(text) && text !== (seed ?? null);
}

function integrationStatus({ shared }) {
  const status = {};
  for (const [source, seeds] of Object.entries(PLUGIN_SEEDS)) {
    const keys = new Set([...Object.keys(seeds), ...storedFor(source).keys()]);
    const set = [...keys].filter((key) => isConfiguredValue(storedValue(shared, source, key), seeds[key])).sort();
    status[source] = { configured: set.length > 0, credentials_set: set };
  }
  return [200, status];
}

const credentialKeyError = (key) => (PLUGIN_IDENTIFIER_RE.test(key) ? null : `Invalid credential key ${preview40(key)}: keys ${PLUGIN_IDENTIFIER_RULES}.`);

function getCredentials({ url, shared }, source) {
  const error = sourceError(source);
  if (error) return fail(400, error);
  const keysParam = url.searchParams.get('keys') ?? '';
  if (!keysParam) return fail(400, 'Missing required query parameter: keys');
  const keys = keysParam.split(',').map((k) => k.trim()).filter(Boolean);
  const badKey = keys.map(credentialKeyError).find(Boolean);
  if (badKey) return fail(400, badKey);
  const result = {};
  for (const key of keys) {
    const value = storedValue(shared, source, key);
    if (value) result[key] = value;
  }
  return [200, result];
}

function putCredentials(_ctx, source, body) {
  const error = sourceError(source);
  if (error) return fail(400, error);
  if (!isPlainObject(body)) return fail(400, 'Request body must be a JSON object.');
  const entries = Object.entries(body);
  if (entries.length > MAX_CREDENTIAL_KEYS_PER_REQUEST) {
    return fail(400, `Too many keys in request: ${entries.length} exceeds the limit of ${MAX_CREDENTIAL_KEYS_PER_REQUEST}.`);
  }
  for (const [key, value] of entries) {
    const keyError = credentialKeyError(key);
    if (keyError) return fail(400, keyError);
    if (value !== null && typeof value !== 'string') return fail(400, `Value for key '${key.slice(0, 40)}' must be a string.`);
  }
  // Falsy values are skipped, never deleted — same as the real route.
  for (const [key, value] of entries) if (value) storedFor(source).set(key, value);
  return [200, { success: true, message: `Credentials updated for ${source}` }];
}

// integrations_handler.py has NO /test route: the request reaches the Lambda
// through the {proxy+} and Powertools answers its own not-found. Mirrored rather
// than faked so local dev does not hide that the Settings "Test" button 404s.
const testIntegration = () => [404, { statusCode: 404, message: 'Not found' }];

// ── /scrapers/manual/* (manual_import_handler.py) ────────────────────────────

const MAX_CHARACTERS = 10000;
const MAX_UPLOAD_ITEMS = 50000;
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const DOMAIN_TO_SOURCE = { 'g2.com': 'g2', 'capterra.com': 'capterra' };
const parseJobs = new Map(); // job id -> { status, polls, source_url, source_origin, raw_text, reviews, unparsed_sections }

function sourceOrigin(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return host ? (DOMAIN_TO_SOURCE[host] ?? host) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Three reviews from the pasted text: one per blank-line block, canned when short. */
function parsedReviews(rawText) {
  const blocks = rawText.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const canned = [
    'Setup took ten minutes and the dashboards were useful on day one.',
    'Exports to CSV drop the custom fields, which makes monthly reporting painful.',
    'Support answered within the hour but the fix needed two follow-ups.',
  ];
  const day = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
  return [
    { text: blocks[0] ?? canned[0], rating: 5, author: 'Priya N.', date: day(3), date_defaulted: false, title: 'Fast to get going' },
    { text: blocks[1] ?? canned[1], rating: 2, author: 'Marcus T.', date: day(9), date_defaulted: false, title: 'Export gaps' },
    // No date in the text: like manual_import_processor.py, the import date with the flag set.
    { text: blocks[2] ?? canned[2], rating: null, author: null, date: day(0), date_defaulted: true, title: null },
  ];
}

function startParse({ shared }, body) {
  const sourceUrl = str(body.source_url).trim();
  const rawText = str(body.raw_text).trim();
  if (!sourceUrl) return fail(400, 'Source URL is required');
  if (!rawText) return fail(400, 'Raw text is required');
  if (rawText.length > MAX_CHARACTERS) return fail(400, `Text exceeds maximum of ${MAX_CHARACTERS} characters`);
  const jobId = shared.nextMockId('parse');
  const origin = sourceOrigin(sourceUrl);
  parseJobs.set(jobId, {
    status: 'processing', polls: 0, source_url: sourceUrl, source_origin: origin, raw_text: rawText,
    reviews: parsedReviews(rawText), unparsed_sections: rawText.length > 400 ? ['Was this review helpful? Yes (3) No (0)'] : [],
  });
  return [200, { success: true, job_id: jobId, source_origin: origin }];
}

function parseStatus(_ctx, jobId) {
  const job = parseJobs.get(jobId);
  if (!job) return fail(404, `Job ${jobId} not found`);
  if (job.status === 'processing' && job.polls >= PARSE_POLLS_BEFORE_DONE) job.status = 'completed';
  job.polls += 1;
  const view = { status: job.status, source_origin: job.source_origin, source_url: job.source_url };
  if (job.status === 'completed') {
    view.reviews = structuredClone(job.reviews);
    view.unparsed_sections = [...job.unparsed_sections];
  }
  return [200, view];
}

function missingDatesError(reviews) {
  const missing = reviews.map((r, i) => (isPlainObject(r) && r.date ? 0 : i + 1)).filter(Boolean);
  if (missing.length === 1) return `Review ${missing[0]} is missing a date. All reviews must have a date.`;
  if (missing.length > 1) return `Reviews ${missing.join(', ')} are missing dates. All reviews must have a date.`;
  return null;
}

function confirmImport({ shared }, body) {
  const jobId = body.job_id;
  const reviews = Array.isArray(body.reviews) ? body.reviews : [];
  if (!jobId) return fail(400, 'Job ID is required');
  if (reviews.length === 0) return fail(400, 'No reviews to import');
  const datesError = missingDatesError(reviews);
  if (datesError) return fail(400, datesError);
  const job = parseJobs.get(String(jobId));
  if (!job) return fail(404, 'Job not found');
  const key = rawKey('manual_import', `${jobId}.json`);
  const finalReviews = reviews.map((r) => pick(r, ['text', 'rating', 'author', 'date', 'title']));
  putRawObject(shared, key, JSON.stringify({
    job_id: jobId, source_url: job.source_url, source_origin: job.source_origin, raw_text: job.raw_text,
    llm_response: { reviews: job.reviews }, final_reviews: finalReviews, imported_at: new Date().toISOString(),
  }));
  for (const review of finalReviews) {
    processImported(shared, {
      source_platform: 'manual_import', source_channel: job.source_origin, text: str(review.text),
      rating: typeof review.rating === 'number' ? review.rating : null, title: str(review.title), url: job.source_url,
      created_at: new Date(Date.parse(review.date) || Date.now()).toISOString(),
    });
  }
  job.status = 'imported';
  return [200, { success: true, imported_count: finalReviews.length, s3_uri: `s3://${MOCK_RAW_BUCKET}/${key}` }];
}

function jsonItemErrors(items) {
  const errors = [];
  items.forEach((item, idx) => {
    if (!isPlainObject(item)) {
      errors.push(`Item ${idx}: must be an object`);
      return;
    }
    if (!str(item.text).trim()) errors.push(`Item ${idx}: "text" is required and must be a non-empty string`);
    if (!item.id) errors.push(`Item ${idx}: "id" is required for deduplication`);
    if (!(item.source || item.source_channel)) errors.push(`Item ${idx}: "source" is required`);
    if (!(item.timestamp || item.created_at)) errors.push(`Item ${idx}: "timestamp" is required (ISO 8601 format)`);
  });
  return errors;
}

function jsonUpload({ shared }, body) {
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) return fail(400, 'Request must contain a non-empty "items" array');
  if (items.length > MAX_UPLOAD_ITEMS) return fail(400, `Maximum ${MAX_UPLOAD_ITEMS} items per upload`);
  const errors = jsonItemErrors(items);
  if (errors.length) return fail(400, `Validation failed: ${errors.slice(0, 10).join('; ')}`);
  const fields = ['id', 'text', 'rating', 'author', 'user_id', 'title', 'url', 'source', 'source_channel', 'timestamp', 'created_at', 'dimensions', 'tags'];
  const clean = items.map((item) => pick(item, fields));
  const key = rawKey('json_upload', `${shared.nextMockId('job')}.json`);
  putRawObject(shared, key, JSON.stringify({ items: clean, uploaded_at: new Date().toISOString() }));
  const sourceId = str(body.source_id).trim() || 'manual_import';
  for (const item of clean) {
    processImported(shared, {
      source_platform: sourceId, dimensions: item.dimensions, tags: item.tags, source_channel: str(item.source || item.source_channel), text: str(item.text).trim(),
      rating: typeof item.rating === 'number' ? item.rating : null, title: str(item.title), url: str(item.url),
      created_at: str(item.timestamp || item.created_at),
    });
  }
  return [200, { success: true, imported_count: clean.length, total_items: items.length, s3_uri: `s3://${MOCK_RAW_BUCKET}/${key}` }];
}

/**
 * Read one quoted field starting just after its opening quote. Doubled quotes
 * are a literal quote. Returns the field text and the index after the closing
 * quote (or input length when the quote never closes).
 */
function readQuotedField(input, start) {
  let field = '';
  let i = start;
  while (i < input.length) {
    if (input[i] !== '"') {
      field += input[i];
      i += 1;
    } else if (input[i + 1] === '"') {
      field += '"';
      i += 2;
    } else {
      return { field, next: i + 1 };
    }
  }
  return { field, next: i };
}

/** RFC 4180 rows: quoted fields, doubled quotes, embedded newlines, CRLF, BOM. */
function parseCsvRows(text) {
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      const quoted = readQuotedField(input, i + 1);
      field += quoted.field;
      i = quoted.next;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const CSV_TEXT_COLUMNS = ['text', 'review', 'comment', 'feedback'];
const CSV_COLUMNS = {
  id: ['id', 'review_id'], rating: ['rating', 'stars', 'score'], date: ['date', 'timestamp', 'created_at'],
  author: ['author', 'user', 'user_id', 'name'], title: ['title', 'subject'], url: ['url', 'link'], source: ['source', 'source_channel'],
};

const CSV_TARGETS = ['text', 'id', 'rating', 'date', 'author', 'title', 'url', 'channel', 'tags', 'metadata', 'ignore'];
const MAX_METADATA_KEYS = 30;
const MAX_METADATA_CHARS = 1000;

/** The target of each header: the column_map entry, else the auto-detected field, else metadata. */
function headerTargets(header, columnMap) {
  const auto = { text: CSV_TEXT_COLUMNS, ...CSV_COLUMNS, channel: CSV_COLUMNS.source };
  return header.map((raw) => {
    const name = raw.trim();
    if (columnMap[name]) return columnMap[name];
    const found = Object.entries(auto).find(([target, names]) => target !== 'source' && names.includes(name.toLowerCase()));
    return found ? found[0] : 'metadata';
  });
}

function badColumnMap(columnMap, shared) {
  if (columnMap === undefined) return null;
  if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap)) return 'column_map must be an object';
  const keys = new Set(shared.dimensionsConfig().map((d) => d.key));
  const bad = Object.values(columnMap).find((target) => !CSV_TARGETS.includes(target)
    && !(typeof target === 'string' && target.startsWith('dimension:') && keys.has(target.slice('dimension:'.length))));
  return bad === undefined ? null : `Unknown column_map target "${bad}"`;
}

/** One row as `{fields, dimensions, tags, metadata}` by the header targets. */
function rowFields(row, header, targets, warnings, idx) {
  const out = { fields: {}, dimensions: {}, tags: [], metadata: {} };
  targets.forEach((target, i) => {
    const value = (row[i] ?? '').trim();
    if (!value || target === 'ignore') return;
    if (target.startsWith('dimension:')) out.dimensions[target.slice('dimension:'.length)] = value;
    else if (target === 'tags') out.tags.push(...value.split(/[,;]/).map((t) => t.trim()).filter(Boolean));
    else if (target !== 'metadata') out.fields[target] ??= value;
    else if (Object.keys(out.metadata).length >= MAX_METADATA_KEYS || value.length > MAX_METADATA_CHARS) {
      warnings.push(`row ${idx}: metadata "${header[i].trim()}" over the limit — dropped`);
    } else out.metadata[header[i].trim()] = value;
  });
  return out;
}

/** _parse_csv_to_items: `{items, warnings}`, or `{error}` for a 400. */
function csvItems(csvText, defaultSource, columnMap) {
  const [header, ...rows] = parseCsvRows(csvText);
  if (!header) return { error: 'CSV is empty or has no header row' };
  const targets = headerTargets(header, columnMap);
  if (!targets.includes('text')) {
    return { error: 'CSV must include a "text" column (also accepted: review / comment / feedback)' };
  }
  const items = [];
  const warnings = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const idx = i + 1;
    const { fields, dimensions, tags, metadata } = rowFields(row, header, targets, warnings, idx);
    if (!fields.text) {
      warnings.push(`row ${idx}: empty text — skipped`);
      return;
    }
    const id = createHash('sha256').update(JSON.stringify(['csv-row-v1', fields.id ?? '', fields.id ? '' : String(idx), fields.text, fields.rating, fields.date, fields.author, fields.title, fields.url, fields.channel])).digest('hex').slice(0, 32);
    if (seen.has(id)) {
      warnings.push(`row ${idx}: duplicate row — skipped`);
      return;
    }
    seen.add(id);
    let rating = null;
    if (fields.rating) {
      const n = Number(fields.rating);
      if (Number.isFinite(n)) rating = Math.trunc(n);
      else warnings.push(`row ${idx}: rating "${fields.rating}" is not a number — left blank`);
    }
    items.push({
      id, text: fields.text, rating, title: fields.title, url: fields.url, author: fields.author,
      created_at: fields.date || new Date().toISOString(), source: fields.channel || defaultSource,
      dimensions, tags: [...new Set(tags)].slice(0, 20), metadata,
    });
  });
  return { items, warnings };
}

function csvUpload({ shared }, body) {
  const csvText = body.csv_text;
  const defaultSource = str(body.default_source).trim() || 'csv_upload';
  const sourceId = str(body.source_id).trim() || 'manual_import';
  if (typeof csvText !== 'string' || !csvText.trim()) return fail(400, 'csv_text is required');
  if (sourceId !== 'manual_import' && !shared.sourceProfiles().some((p) => p.id === sourceId)) {
    return fail(400, 'source_id must be a configured source profile or manual_import');
  }
  const mapError = badColumnMap(body.column_map, shared);
  if (mapError) return fail(400, mapError);
  if (Buffer.byteLength(csvText) > MAX_CSV_BYTES) return fail(400, `CSV exceeds ${MAX_CSV_BYTES / (1024 * 1024)} MB limit`);
  const { items, warnings, error } = csvItems(csvText, defaultSource, body.column_map ?? {});
  if (error) return fail(400, error);
  if (items.length === 0) return fail(400, `CSV produced no valid rows. ${warnings.slice(0, 5).join('; ')}`);
  if (items.length > MAX_UPLOAD_ITEMS) return fail(400, `Maximum ${MAX_UPLOAD_ITEMS} rows per upload (got ${items.length}). Split the file and try again.`);
  const key = rawKey('csv_upload', `${shared.nextMockId('job')}.csv`);
  putRawObject(shared, key, csvText, 'text/csv; charset=utf-8');
  for (const item of items) processImported(shared, { ...item, source_platform: sourceId, source_channel: item.source });
  const result = { success: true, imported_count: items.length, total_rows: items.length, s3_uri: `s3://${MOCK_RAW_BUCKET}/${key}` };
  if (warnings.length) result.warnings = warnings.slice(0, 20);
  return [200, result];
}

// ── /s3-import/* (s3_import_handler.py) + the mock presigned PUT ─────────────

const UPLOAD_PATH = '/mock-s3-import-upload/';
const importFolders = new Set(['reviews_export', 'support_tickets']);
const importFiles = new Map([
  ['reviews_export/june_reviews.csv', { size: 48213, last_modified: isoAgo(3 * HOUR_MS) }],
  ['reviews_export/app_store_dump.jsonl', { size: 120488, last_modified: isoAgo(DAY_MS) }],
  ['support_tickets/q2_tickets.json', { size: 9132, last_modified: isoAgo(2 * DAY_MS) }],
  // Already ingested: listed only with ?include_processed=true.
  ['processed/reviews_export/may_reviews.csv', { size: 39950, last_modified: isoAgo(20 * DAY_MS) }],
]);
const issuedUploadKeys = new Set();
const safeName = (value, pattern) => value.replace(pattern, '_');

function listImportSources() {
  const sources = [...importFolders].filter((f) => f !== 'processed').sort()
    .map((name) => ({ name, display_name: `S3 - ${name}` }));
  return [200, { sources, bucket: MOCK_S3_IMPORT_BUCKET }];
}

function createImportSource(_ctx, body) {
  const name = str(body.name).trim();
  if (!name) return fail(400, 'Source name is required');
  const safe = safeName(name, /[^a-zA-Z0-9_-]/g);
  importFolders.add(safe);
  return [200, { success: true, source: { name: safe, display_name: `S3 - ${safe}` } }];
}

function listImportFiles({ url }) {
  const source = url.searchParams.get('source') ?? '';
  const includeProcessed = (url.searchParams.get('include_processed') ?? 'false').toLowerCase() === 'true';
  const files = [...importFiles.entries()]
    .filter(([key]) => (!source || key.startsWith(`${source}/`)) && /\.(csv|json|jsonl)$/.test(key))
    .filter(([key]) => includeProcessed || !key.startsWith('processed/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, meta]) => {
      const parts = key.split('/');
      return {
        key, filename: parts.at(-1), source: parts.length > 1 ? parts[0] : 'root', size: meta.size,
        last_modified: meta.last_modified, status: key.startsWith('processed/') ? 'processed' : 'pending',
      };
    });
  return [200, { files, bucket: MOCK_S3_IMPORT_BUCKET }];
}

function uploadUrl({ req }, body) {
  const filename = str(body.filename).trim();
  const source = (str(body.source) || 'default').trim();
  if (!filename) return fail(400, 'Filename is required');
  if (!/\.(csv|json|jsonl)$/.test(filename)) return fail(400, 'Only CSV, JSON, and JSONL files are supported');
  const key = `${safeName(source, /[^a-zA-Z0-9_-]/g)}/${safeName(filename, /[^a-zA-Z0-9_.-]/g)}`;
  issuedUploadKeys.add(key);
  const host = req.headers.host ?? 'localhost:3001';
  return [200, {
    success: true, upload_url: `http://${host}${UPLOAD_PATH}${encodeURIComponent(key)}`,
    key, bucket: MOCK_S3_IMPORT_BUCKET, expires_in: 7200,
  }];
}

/** The browser's PUT to the "presigned" URL: drain it, then list the object. */
function receiveUpload({ req, res }, key) {
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; });
  req.on('error', () => res.destroy());
  req.on('end', () => {
    if (!issuedUploadKeys.has(key)) {
      // S3 refuses a PUT whose signature it did not issue.
      res.writeHead(403);
      res.end(JSON.stringify({ success: false, error: 'SignatureDoesNotMatch' }));
      return;
    }
    importFiles.set(key, { size, last_modified: new Date().toISOString() });
    importFolders.add(key.split('/')[0]);
    res.writeHead(200);
    res.end();
  });
  return null;
}

function deleteImportFile(_ctx, key) {
  importFiles.delete(key); // delete_object is idempotent: a missing key also succeeds
  return [200, { success: true, deleted_key: key }];
}

// ── /data-explorer/* writes + preview (data_explorer_handler.py) ─────────────

const DATA_EXPLORER_BUCKETS = new Set(['raw-data']);
const RAW_BUCKET_NAME = 'voc-raw-data-123456789012-us-west-2';
const RAW_BUCKET_LABEL = 'VoC Raw Data';

/** The backend's `prefix.strip('/')`, without a backtracking regex. */
function trimSlashes(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '/') start += 1;
  while (end > start && text[end - 1] === '/') end -= 1;
  return text.slice(start, end);
}

/** GET /data-explorer/buckets, per AVAILABLE_BUCKETS. */
function listBuckets() {
  return [200, { buckets: [{ id: 'raw-data', name: RAW_BUCKET_NAME, label: RAW_BUCKET_LABEL, description: 'Raw feedback data from all sources' }] }];
}

/**
 * GET /data-explorer/s3 — list_objects_v2 with Delimiter '/' over the same
 * object store the preview and save routes use, so every listed file previews.
 */
function listObjects({ url }) {
  const bucketId = url.searchParams.get('bucket') ?? 'raw-data';
  if (!DATA_EXPLORER_BUCKETS.has(bucketId)) {
    return [200, { objects: [], bucket: null, bucketId, prefix: '', error: 'Bucket not configured' }];
  }
  const trimmed = trimSlashes(url.searchParams.get('prefix') ?? '');
  const prefix = trimmed ? `${trimmed}/` : '';
  const folders = new Set();
  const files = [];
  for (const [key, object] of rawObjects) {
    if (!key.startsWith(prefix) || key === prefix) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) folders.add(rest.slice(0, slash));
    else files.push({ key: rest, fullKey: key, size: Buffer.byteLength(object.content), lastModified: object.lastModified, isFolder: false });
  }
  // Folders first, then case-insensitive by name (the backend's sort key).
  const byName = (a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase());
  const objects = [
    ...[...folders].map((name) => ({ key: name, size: 0, lastModified: '', isFolder: true })).sort(byName),
    ...files.sort(byName),
  ];
  return [200, { objects, bucket: RAW_BUCKET_NAME, bucketId, bucketLabel: RAW_BUCKET_LABEL, prefix: trimmed }];
}

function bucketKeyError(request) {
  const bucket = request.bucket ?? 'raw-data';
  if (!DATA_EXPLORER_BUCKETS.has(bucket)) return fail(500, 'Bucket not configured');
  if (!request.key) return fail(400, 'File key is required');
  return null;
}

function previewObject({ url }) {
  const request = { bucket: url.searchParams.get('bucket') ?? undefined, key: url.searchParams.get('key') ?? '' };
  const error = bucketKeyError(request);
  if (error) return error;
  const object = rawObjects.get(request.key);
  if (!object) return fail(404, 'File not found');
  let content = object.content;
  try {
    content = JSON.parse(object.content);
  } catch {
    // Not JSON: previewed as text, exactly as stored.
  }
  return [200, { content, size: Buffer.byteLength(object.content), contentType: object.contentType, key: request.key }];
}

function saveObject({ shared }, body) {
  const error = bucketKeyError(body);
  if (error) return error;
  const key = String(body.key);
  if (key.startsWith('prototypes/')) return fail(400, 'Generated prototypes are read-only in Data Explorer');
  const content = isPlainObject(body.content) ? JSON.stringify(body.content, null, 2) : (body.content ?? '');
  if (typeof content !== 'string') return fail(400, 'content must be a string or a JSON object');
  if (key.startsWith('raw/') && rawObjects.has(key)) {
    return fail(409, 'Raw data is immutable: an object already exists at this key under raw/');
  }
  putRawObject(shared, key, content);
  const synced = body.sync_to_dynamo === true && (body.bucket ?? 'raw-data') === 'raw-data' && syncToFeedback(shared, content);
  return [200, { success: true, message: 'File saved', key, synced }];
}

/** sync_to_dynamo: re-process a saved JSON object; a non-JSON body is saved but not synced. */
function syncToFeedback(shared, content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  if (str(parsed.text).trim()) {
    processImported(shared, {
      source_platform: str(parsed.source_platform) || 'manual', source_channel: str(parsed.source_channel) || 'data_explorer',
      text: str(parsed.text), rating: typeof parsed.rating === 'number' ? parsed.rating : null, created_at: str(parsed.created_at),
    });
  }
  return true;
}

const UPDATABLE_FEEDBACK_FIELDS = [
  'original_text', 'normalized_text', 'sentiment_label', 'sentiment_score', 'urgency', 'impact_area',
  'problem_summary', 'problem_root_cause_hypothesis', 'persona_name', 'persona_type', 'journey_stage', 'rating',
];

function labelOf(value, key, required) {
  if (value === null || value === undefined || value === '') return required ? { error: `${key} is required` } : { value: null };
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > 100) return { error: `${key} must be a string of 1-100 characters` };
  return { value: text };
}

/** `{change}` (null = unchanged) or `{error}`, per data_explorer_handler._category_change. */
function categoryChange(shared, item, data) {
  if (!Object.hasOwn(data, 'category') && !Object.hasOwn(data, 'subcategory')) return { change: null };
  const category = labelOf(Object.hasOwn(data, 'category') ? data.category : item.category, 'category', true);
  if (category.error) return category;
  let subcategory = { value: category.value === item.category ? (item.subcategory ?? null) : null };
  if (Object.hasOwn(data, 'subcategory')) subcategory = labelOf(data.subcategory, 'subcategory', false);
  if (subcategory.error) return subcategory;
  if (category.value === item.category && subcategory.value === (item.subcategory ?? null)) return { change: null };
  const entry = shared.mockCategoriesConfig.categories.find((c) => c.name === category.value);
  if (!entry) return { error: 'category is not a configured category' };
  const names = new Set((Array.isArray(entry.subcategories) ? entry.subcategories : []).map((s) => s?.name));
  if (subcategory.value !== null && names.size > 0 && !names.has(subcategory.value)) {
    return { error: 'subcategory does not belong to this category' };
  }
  return { change: { category: category.value, subcategory: subcategory.value } };
}

function saveFeedback({ shared }, body) {
  const feedbackId = body.feedback_id;
  const data = body.data ?? {};
  if (!feedbackId) return fail(400, 'Feedback ID is required');
  if (!isPlainObject(data)) return fail(400, 'data must be an object');
  const plain = pick(data, UPDATABLE_FEEDBACK_FIELDS);
  const touchesCategory = Object.hasOwn(data, 'category') || Object.hasOwn(data, 'subcategory');
  if (Object.keys(plain).length === 0 && !touchesCategory) return fail(400, 'No fields to update');
  const item = shared.mockFeedback.find((f) => f.feedback_id === String(feedbackId)
    && (!data.source_platform || f.source_platform === data.source_platform));
  if (!item) return fail(404, 'Feedback not found');
  const { change, error } = categoryChange(shared, item, data);
  if (error) return fail(400, error);
  if (change === null && Object.keys(plain).length === 0) return [200, { success: true, message: 'No changes' }];
  Object.assign(item, plain);
  if (change) {
    item.category = change.category;
    if (change.subcategory === null) delete item.subcategory;
    else item.subcategory = change.subcategory;
    item.category_source = 'manual';
  }
  item.updated_at = new Date().toISOString();
  return [200, { success: true, message: 'Feedback updated' }];
}

// ── Route table ──────────────────────────────────────────────────────────────
// [method, pattern, body mode, handler]. Body modes: 'none' (no body read),
// 'json' (shared.collectJson, a non-object body -> {}), 'rawjson' (collectJson,
// the body passed as parsed so the handler can 400 a non-object itself),
// 'lenient' (a missing or malformed body is ignored, as run_source does),
// 'raw' (the handler drains the stream and answers itself).

const ROUTES = [
  ['GET', /^\/logs\/validation$/, 'none', (c) => listLogs(c, validationLogs)],
  ['GET', /^\/logs\/processing$/, 'none', (c) => listLogs(c, processingLogs)],
  ['GET', /^\/logs\/scraper\/([^/]+)$/, 'none', (c, id) => scraperLogs(c, id)],
  ['GET', /^\/logs\/summary$/, 'none', logsSummary],
  ['DELETE', /^\/logs\/validation\/([^/]+)$/, 'none', clearValidationLogs],
  ['GET', /^\/feedback\/search$/, 'none', searchFeedback],
  ['PUT', /^\/sources\/([^/]+)\/(enable|disable)$/, 'none', toggleSource],
  ['POST', /^\/sources\/([^/]+)\/run$/, 'lenient', (c, source) => runSource(c, source)],
  ['POST', /^\/settings\/categories\/generate$/, 'json', (c, body) => generateCategories(c, body)],
  ['GET', /^\/integrations\/status$/, 'none', integrationStatus],
  ['GET', /^\/integrations\/([^/]+)\/credentials$/, 'none', getCredentials],
  ['PUT', /^\/integrations\/([^/]+)\/credentials$/, 'rawjson', putCredentials],
  ['POST', /^\/integrations\/([^/]+)\/test$/, 'none', testIntegration],
  ['GET', /^\/scrapers\/templates$/, 'none', () => [200, { templates: structuredClone(SCRAPER_TEMPLATES) }]],
  ['POST', /^\/scrapers\/analyze-url$/, 'json', analyzeUrl],
  ['POST', /^\/scrapers\/manual\/parse$/, 'json', startParse],
  ['GET', /^\/scrapers\/manual\/parse\/([^/]+)$/, 'none', parseStatus],
  ['POST', /^\/scrapers\/manual\/confirm$/, 'json', confirmImport],
  ['POST', /^\/scrapers\/manual\/json-upload$/, 'json', jsonUpload],
  ['POST', /^\/scrapers\/manual\/csv-upload$/, 'json', csvUpload],
  ['POST', /^\/scrapers\/([^/]+)\/run$/, 'none', runScraper],
  ['GET', /^\/scrapers\/([^/]+)\/runs$/, 'none', scraperRuns],
  ['DELETE', /^\/scrapers\/([^/]+)$/, 'none', deleteScraper],
  ['GET', /^\/s3-import\/sources$/, 'none', listImportSources],
  ['POST', /^\/s3-import\/sources$/, 'json', createImportSource],
  ['GET', /^\/s3-import\/files$/, 'none', listImportFiles],
  ['POST', /^\/s3-import\/upload-url$/, 'json', uploadUrl],
  ['DELETE', /^\/s3-import\/file\/(.+)$/, 'none', deleteImportFile],
  ['PUT', /^\/mock-s3-import-upload\/(.+)$/, 'raw', receiveUpload],
  ['GET', /^\/data-explorer\/buckets$/, 'none', listBuckets],
  ['GET', /^\/data-explorer\/s3$/, 'none', listObjects],
  ['GET', /^\/data-explorer\/s3\/preview$/, 'none', previewObject],
  ['PUT', /^\/data-explorer\/s3$/, 'json', saveObject],
  ['PUT', /^\/data-explorer\/feedback$/, 'json', saveFeedback],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, mode, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pathname.match(pattern);
    if (match) return { mode, handler, captures: match.slice(1) };
  }
  return null;
}

function decodeAll(captures) {
  try {
    return captures.map((c) => decodeURIComponent(c));
  } catch {
    return null;
  }
}

/** Read a body that may be absent or malformed; `onBody` gets `{}` for either. */
function collectLenient(req, onBody) {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    onBody(isPlainObject(body) ? body : {});
  });
}

/** Handle the routes listed in ROUTES; returns true when the request was taken. */
export function handleSourceRoutes(req, res, url, send, shared) {
  const route = matchRoute(req.method, url.pathname);
  if (!route) return false;
  const captures = decodeAll(route.captures);
  const ctx = { req, res, url, shared };
  const answer = (result) => {
    if (result) send(result[0], result[1]);
  };
  if (!captures) {
    send(400, { success: false, error: 'Malformed path parameter' });
    return true;
  }
  if (route.mode === 'none' || route.mode === 'raw') {
    answer(route.handler(ctx, ...captures));
  } else if (route.mode === 'lenient') {
    collectLenient(req, (body) => answer(route.handler(ctx, ...captures, body)));
  } else if (route.mode === 'rawjson') {
    // The body itself is validated (a non-object is a 400 with its own message).
    shared.collectJson(req, res, (body) => answer(route.handler(ctx, ...captures, body)));
  } else {
    shared.collectJson(req, res, (body) => answer(route.handler(ctx, ...captures, isPlainObject(body) ? body : {})));
  }
  return true;
}
