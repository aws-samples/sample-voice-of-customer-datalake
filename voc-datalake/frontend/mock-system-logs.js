// Dev mock of Administration → System → Logs → System errors (admin-only on the real
// routes; the dev mock's session is an admin). Wire shapes follow lambda/api/logs_handler.py
// and lambda/shared/system_*.py:
//   GET /logs/system              grouped ERROR/CRITICAL(/WARNING) lines of Lambdas, the API
//                                 Gateway access log (level HTTP) and Step Functions (workflow)
//   GET /logs/system/request      every line of one invocation of one function
//   GET /logs/system/queues       dead-letter / failure queues: depth, oldest age, samples
//   GET /logs/system/environment  what is deployed and how it is configured
// The two Logs Insights routes are stateful like the real ones: a fresh search answers
// `running` with a query id; polling with that id answers `complete`. Wired into the
// route table of mock-sources.js.

import { randomUUID } from 'node:crypto';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const fail = (status, error) => [status, { success: false, error }];
const bad = (error) => fail(400, error);

const SYSTEM_LOG_GROUP_COUNT = 57;
/** Query ids, Lambda / Node / API Gateway request ids: all UUID-shaped. */
const UUID_SHAPE_RE = /^[0-9a-f-]{36}$/;
const FUNCTION_RE = /^[a-z0-9_-]{1,64}$/;
const REQUEST_WINDOW_MS = 20 * MINUTE_MS;
const searches = new Set(); // query ids issued and not yet read

/** Hands out `count` query ids for a fresh search. */
function startSearch(count) {
  const ids = Array.from({ length: count }, () => randomUUID());
  for (const id of ids) searches.add(id);
  return ids.join(',');
}

/** 'invalid' (malformed), 'unknown' (never issued: a restarted mock) or 'ok' (consumed). */
function readSearch(raw) {
  const ids = raw.split(',');
  if (ids.length > 4 || !ids.every((id) => UUID_SHAPE_RE.test(id))) return 'invalid';
  if (!ids.every((id) => searches.has(id))) return 'unknown';
  for (const id of ids) searches.delete(id);
  return 'ok';
}

const AVATAR_REQUEST_ID = '7f3c2a10-4b8e-4d1a-9c55-0e2b6d9a1f37';
const TIMEOUT_REQUEST_ID = '1b9e2c44-7a10-4f3e-8d2a-5c6b7e8f9a01';

function groupFixtures() {
  return [
    { function: 'projects-assist', source: 'lambda', level: 'ERROR', count: 3, first_seen: isoAgo(5 * HOUR_MS), last_seen: isoAgo(20 * MINUTE_MS),
      message: '[PERSONA_AVATAR] FAILED - Avatar generation error: AccessDeniedException: <str> is not authorized to perform: bedrock:InvokeModel',
      sample: '[PERSONA_AVATAR] FAILED - Avatar generation error: AccessDeniedException: An error occurred (AccessDeniedException) when calling the InvokeModel operation: User: arn:aws:sts::123456789012:assumed-role/voc-projects-api-role/voc-projects-assist is not authorized to perform: bedrock:InvokeModel\nTraceback (most recent call last):\n  File "/var/task/shared/avatar.py", line 88, in generate_avatar\n    response = bedrock.invoke_model(**request)',
      request_id: AVATAR_REQUEST_ID },
    { function: 'api', source: 'api', level: 'HTTP', count: 4, first_seen: isoAgo(3 * HOUR_MS), last_seen: isoAgo(40 * MINUTE_MS),
      message: 'POST /projects/{id}/personas/generate → 502 Internal server error',
      sample: 'POST /projects/proj_1/personas/generate → 502 Internal server error (integration status 200)',
      request_id: 'c0a8e1d2-3f4b-4c5d-8e9f-0a1b2c3d4e5f' },
    { function: 'research', source: 'workflow', level: 'ERROR', count: 1, first_seen: isoAgo(26 * HOUR_MS), last_seen: isoAgo(26 * HOUR_MS),
      message: 'ExecutionFailed States.TaskFailed: Lambda.Unknown',
      sample: 'ExecutionFailed States.TaskFailed: Lambda.Unknown — The cause could not be determined because Lambda did not return an error type. Returned payload: {"errorMessage":"2026-10-26T08:00:00.000Z 3a2b1c0d Task timed out after 300.00 seconds"}',
      request_id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d' },
    { function: 'chat-stream', source: 'lambda', level: 'PLATFORM', count: 1, first_seen: isoAgo(2 * DAY_MS), last_seen: isoAgo(2 * DAY_MS),
      message: 'Task timed out after <n> seconds', sample: `2026-10-25T09:12:44.512Z ${TIMEOUT_REQUEST_ID} Task timed out after 900.00 seconds`,
      request_id: TIMEOUT_REQUEST_ID },
    { function: 'api', source: 'api', level: 'WARNING', count: 9, first_seen: isoAgo(4 * DAY_MS), last_seen: isoAgo(2 * HOUR_MS),
      message: 'PUT /settings/categories → 409 Conflict', sample: 'PUT /settings/categories → 409 Conflict', request_id: null },
    { function: 'ingestor-app-reviews-ios', source: 'lambda', level: 'WARNING', count: 12, first_seen: isoAgo(6 * DAY_MS), last_seen: isoAgo(3 * HOUR_MS),
      message: 'App Store RSS returned <n> for app <n> (Example Air); retrying next run',
      sample: 'App Store RSS returned 503 for app 1234567890 (Example Air); retrying next run', request_id: null },
    { function: 'processor', source: 'lambda', level: 'CRITICAL', count: 2, first_seen: isoAgo(20 * DAY_MS), last_seen: isoAgo(9 * DAY_MS),
      message: 'Unhandled error processing record <hex>: ValidationException: Input is too long for requested model',
      sample: 'Unhandled error processing record 9f2c4e1a: ValidationException: Input is too long for requested model', request_id: null },
  ];
}

function groupsAnswer(days, level) {
  const cutoff = Date.now() - days * DAY_MS;
  const groups = groupFixtures()
    .filter((g) => level === 'warning' || g.level !== 'WARNING')
    .filter((g) => Date.parse(g.last_seen) >= cutoff)
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  return { status: 'complete', days, level, log_groups: SYSTEM_LOG_GROUP_COUNT, truncated: false, count: groups.length, groups };
}

/** GET /logs/system. */
function systemLogs({ url }) {
  const params = url.searchParams;
  const days = Number.parseInt(params.get('days') ?? '1', 10);
  const level = params.get('level') ?? 'error';
  if (![1, 7, 30].includes(days) || !['error', 'warning'].includes(level)) return bad('Invalid days or level');
  const base = { days, level, log_groups: SYSTEM_LOG_GROUP_COUNT, truncated: false, count: 0, groups: [] };
  const raw = params.get('query_id');
  if (raw === null || raw === '') return [200, { ...base, status: 'running', query_id: startSearch(2) }];
  const read = readSearch(raw);
  if (read === 'invalid') return bad('Invalid query_id');
  if (read === 'unknown') return [200, { ...base, status: 'failed', message: 'The log search could not be read', log_groups: 0 }];
  return [200, groupsAnswer(days, level)];
}

// ── GET /logs/system/request ─────────────────────────────────────────────────

/** Functions with a log group the mock knows (the real route resolves the discovered names; others 404). */
const REQUEST_FUNCTIONS = new Set(['projects-assist', 'chat-stream', 'processor', 'research', 'ingestor-app-reviews-ios', 'metrics-api']);

function requestLines(fn, requestId, at) {
  const t0 = Date.parse(at) - 4_000;
  const line = (offsetMs, level, message) => ({ timestamp: new Date(t0 + offsetMs).toISOString(), level, message });
  if (requestId === AVATAR_REQUEST_ID) {
    return [
      line(0, 'INFO', `START RequestId: ${requestId} Version: $LATEST`),
      line(12, 'INFO', '{"level":"INFO","message":"Assist job started","job_type":"assist_regenerate_avatar","project_id":"proj_1"}'),
      line(40, 'INFO', '{"level":"INFO","message":"[PERSONA_AVATAR] Generating avatar","model_id":"stability.stable-image-core-v1:1","region":"us-west-2"}'),
      line(910, 'ERROR', '{"level":"ERROR","message":"[PERSONA_AVATAR] FAILED - Avatar generation error: AccessDeniedException","reason":"no_access","model_id":"stability.stable-image-core-v1:1","region":"us-west-2"}'),
      line(925, 'INFO', '{"level":"INFO","message":"Assist job failed","job_id":"assist_8c1d"}'),
      line(931, 'INFO', `END RequestId: ${requestId}`),
      line(931, 'INFO', `REPORT RequestId: ${requestId} Duration: 931.40 ms Billed Duration: 932 ms Memory Size: 1024 MB Max Memory Used: 188 MB`),
    ];
  }
  return [
    line(0, 'INFO', `START RequestId: ${requestId} Version: $LATEST`),
    line(25, 'INFO', `{"level":"INFO","message":"${fn} invoked"}`),
    line(3_990, 'ERROR', `{"level":"ERROR","message":"${fn} failed; see the System errors row"}`),
    line(4_000, 'INFO', `END RequestId: ${requestId}`),
  ];
}

/** GET /logs/system/request?function=&request_id=&at=[&query_id=]. */
function systemRequest({ url }) {
  const params = url.searchParams;
  const fn = params.get('function') ?? '';
  const requestId = params.get('request_id') ?? '';
  const at = params.get('at') ?? '';
  if (!FUNCTION_RE.test(fn) || !UUID_SHAPE_RE.test(requestId) || Number.isNaN(Date.parse(at))) {
    return bad('Invalid function, request_id or at');
  }
  if (!REQUEST_FUNCTIONS.has(fn)) return fail(404, 'Unknown function');
  const raw = params.get('query_id');
  if (raw === null || raw === '') return [200, { status: 'running', query_id: startSearch(1), lines: [], truncated: false }];
  const read = readSearch(raw);
  if (read === 'invalid') return bad('Invalid query_id');
  if (read === 'unknown') return [200, { status: 'failed', message: 'The log search could not be read', lines: [], truncated: false }];
  const from = Date.parse(at) - REQUEST_WINDOW_MS;
  const lines = requestLines(fn, requestId, at).filter((l) => Date.parse(l.timestamp) >= from);
  return [200, { status: 'complete', lines, truncated: false }];
}

// ── GET /logs/system/queues ──────────────────────────────────────────────────

function systemQueues() {
  return [200, { queues: [
    { name: 'voc-processing-dlq', messages: 2, oldest_age_seconds: 3 * 3600 + 120, sample: [
      '{"id":"rev_9f2c4e1a","source_platform":"webscraper","text":"[REDACTED:EMAIL] says the checkout page times out","s3_raw_uri":"s3://voc-raw-data-123456789012-us-west-2/raw/webscraper/2026/10/27/rev_9f2c4e1a.json"}',
      '{"id":"rev_51b7","source_platform":"app_reviews_ios","text":"Crashes on launch since the last update"}',
    ] },
    { name: 'voc-memory-extract-dlq', messages: 1, oldest_age_seconds: 26 * 3600, sample: [
      '{"kind":"agent_run","run_id":"run_3a2b1c0d","agent_id":"agt_1"}',
    ] },
    { name: 'voc-agent-run-failures', messages: 0, sample: [] },
    { name: 'voc-assist-failures', messages: 0, sample: [] },
  ] }];
}

// ── GET /logs/system/environment ─────────────────────────────────────────────

function systemEnvironment() {
  // Same fields as lambda/shared/system_environment.py (no version: the SPA shows its own build stamp).
  return [200, {
    region: 'us-west-2',
    account_suffix: '9012',
    deployment_prefix: '',
    enabled_sources: ['webscraper', 'app_reviews_ios', 'app_reviews_android', 'github_issues', 'web_reviews'],
    web_search: true,
    inference_scope: 'global',
    image_model: { id: 'stability.stable-image-core-v1:1', region: 'us-west-2', avatars_enabled: true },
    models: {
      effective: { chat: 'global.anthropic.claude-sonnet-5-5', enrichment: 'global.anthropic.claude-haiku-5-5' },
      overrides: { enrichment: 'global.anthropic.claude-haiku-5-5' },
    },
    alerting: { configured: true, enabled: false, alarms: [], in_alarm: 0 },
    open_circuits: [{ source: 'web_reviews', tripped_at: isoAgo(5 * HOUR_MS), failure_count: 5, last_error: 'blocked by HTTP 403' }],
    log_coverage: {
      lambda_log_group_pattern: '/aws/lambda/voc-*-<account>-us-west-2',
      extra_lambda_functions: ['product-doc-extractor', 'cognito-custom-message', 'admin-bootstrap', 'cdn-signing-keys'],
      workflow_logs: true,
      api_access_log: true,
    },
  }];
}

/** Route rows for mock-sources.js's table: [method, pattern, body mode, handler]. */
export const SYSTEM_LOG_ROUTES = [
  ['GET', /^\/logs\/system$/, 'none', systemLogs],
  ['GET', /^\/logs\/system\/request$/, 'none', systemRequest],
  ['GET', /^\/logs\/system\/queues$/, 'none', systemQueues],
  ['GET', /^\/logs\/system\/environment$/, 'none', systemEnvironment],
];
