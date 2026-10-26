// Operational alerting mock: GET|PUT /logs/alerts, POST /logs/alerts/recipients
// and POST /logs/alerts/recipients/remove in the lambda/shared/ops_alerts_service.py
// wire shape ({configured, enabled, updated_at, updated_by, alarms, expected_alarm_count,
// billed_metric_count, subscribers, max_subscribers}; {success: false, error} on 400/404/409).
// Stateful for the life of the mock process. One recipient starts pending and one
// confirmed, so both badges render; a recipient added here confirms itself after
// ten seconds, like a person clicking the AWS link.
// Wired into mock-server.js by handleDomainModules.

const STATUS_ROUTE = '/logs/alerts';
const ADD_ROUTE = '/logs/alerts/recipients';
const REMOVE_ROUTE = '/logs/alerts/recipients/remove';
const PREFIX = 'voc-alerts-123456789012-us-east-1';
const SLUGS = [
  'processing-dlq', 'ingest-schedule-dlq', 'aggregator-stream-failures', 'memory-extract-dlq',
  'api-async-failures', 'processor-errors', 'aggregator-errors', 'aggregator-iterator-age', 'ingestor-errors',
];
const BILLED_METRICS = SLUGS.length - 1 + 3; // the ingestor SUM covers three mock ingestors
const MAX_SUBSCRIBERS = 10;
const CONFIRM_AFTER_MS = 10_000;
const MAX_EMAIL_LENGTH = 254;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

const state = {
  enabled: false,
  updated_at: null,
  updated_by: null,
  recipients: [
    { email: 'ops-team@example.com', status: 'confirmed' },
    { email: 'on-call@example.com', status: 'pending' },
  ],
};

function view() {
  return {
    configured: true,
    enabled: state.enabled,
    ...(state.updated_at ? { updated_at: state.updated_at, updated_by: state.updated_by } : {}),
    alarms: state.enabled ? SLUGS.map((slug) => ({ name: `${PREFIX}-${slug}`, state: 'OK' })) : [],
    expected_alarm_count: SLUGS.length,
    billed_metric_count: BILLED_METRICS,
    subscribers: [...state.recipients].sort((a, b) => a.email.localeCompare(b.email)),
    max_subscribers: MAX_SUBSCRIBERS,
  };
}

function normalizedEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null;
}

function setEnabled(body) {
  if (typeof body?.enabled !== 'boolean') return [400, { success: false, error: 'enabled must be true or false' }];
  const existingAlarms = state.enabled ? SLUGS.length : 0;
  state.enabled = body.enabled;
  state.updated_at = new Date().toISOString();
  state.updated_by = 'admin@example.com';
  return [200, {
    success: true, enabled: state.enabled, alarm_count: state.enabled ? SLUGS.length : 0,
    deleted_count: state.enabled ? 0 : existingAlarms, updated_at: state.updated_at,
  }];
}

function addRecipient(body) {
  const email = normalizedEmail(body?.email);
  if (!email) return [400, { success: false, error: 'email is not a valid address' }];
  const existing = state.recipients.find((r) => r.email === email);
  if (existing?.status === 'confirmed') return [200, { success: true, email, status: 'confirmed' }];
  if (!existing && state.recipients.length >= MAX_SUBSCRIBERS) {
    return [400, { success: false, error: `at most ${MAX_SUBSCRIBERS} recipients` }];
  }
  if (!existing) state.recipients.push({ email, status: 'pending' });
  setTimeout(() => {
    const row = state.recipients.find((r) => r.email === email);
    if (row) row.status = 'confirmed';
  }, CONFIRM_AFTER_MS).unref();
  return [200, { success: true, email, status: 'pending' }];
}

function removeRecipient(body) {
  const email = normalizedEmail(body?.email);
  if (!email) return [400, { success: false, error: 'email is not a valid address' }];
  if (!state.recipients.some((r) => r.email === email)) return [404, { success: false, error: 'recipient not found' }];
  state.recipients = state.recipients.filter((r) => r.email !== email);
  return [200, { success: true, email }];
}

const WRITES = {
  [`PUT ${STATUS_ROUTE}`]: setEnabled,
  [`POST ${ADD_ROUTE}`]: addRecipient,
  [`POST ${REMOVE_ROUTE}`]: removeRecipient,
};

/** Handle `/logs/alerts*`; returns true when the request was taken. */
export function handleAlertRoutes(req, res, url, send, shared) {
  if (![STATUS_ROUTE, ADD_ROUTE, REMOVE_ROUTE].includes(url.pathname)) return false;
  if (req.method === 'GET' && url.pathname === STATUS_ROUTE) {
    send(200, view());
    return true;
  }
  const write = WRITES[`${req.method} ${url.pathname}`];
  if (!write) {
    send(405, { success: false, error: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const [status, payload] = write(body);
    send(status, payload);
  });
  return true;
}
