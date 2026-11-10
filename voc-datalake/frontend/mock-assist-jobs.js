// Owner-scoped assist jobs (shared/assist_jobs.py, pk `ASSIST#{caller_sub}`): the
// settings and scrapers model calls that answer 202 + a job id instead of their
// body. GET /settings/jobs/{id} and GET /scrapers/jobs/{id} read them in the
// assist_jobs.view shape. A job completes on its FIRST poll, its `result` the
// exact body the route used to answer. Project assists use the project job
// registry in mock-project-actions.js instead (polled via /projects/{id}/jobs/{id}).
// Stateful for the life of the mock process; the mock has one caller, so the
// owner scope is the domain (`settings` / `scrapers`): a settings job id is a 404
// on the scrapers read, as a job of another kind would be on the real one.
// Wired into mock-server.js by handleDomainModules; routes reach `startOwnerAssistJob`
// through `shared`.

import { randomBytes } from 'node:crypto';

const JOB_READ = /^\/(settings|scrapers)\/jobs\/([^/]+)$/;
const ownerJobs = new Map(); // job id -> { scope, record }

const nowIso = () => new Date().toISOString();

/**
 * assist_jobs.start: `answer` is the [status, body] the route used to send. An
 * error answer is sent as is (the route's preconditions run before the start);
 * a success becomes 202 + a pending job whose `result` is that body.
 */
export function startOwnerAssistJob(scope, jobType, answer) {
  const [status, body] = answer;
  if (status !== 200) return answer;
  const jobId = `job_${randomBytes(8).toString('hex')}`;
  const at = nowIso();
  ownerJobs.set(jobId, {
    scope,
    result: body,
    record: {
      job_id: jobId, job_type: jobType, status: 'pending',
      created_at: at, updated_at: at, completed_at: null, error: null, result: null,
    },
  });
  return [202, { success: true, job_id: jobId, status: 'pending' }];
}

function readJob(scope, jobId) {
  const entry = ownerJobs.get(jobId);
  if (!entry || entry.scope !== scope) return [404, { success: false, error: 'Job not found' }];
  const { record } = entry;
  if (record.status === 'pending') {
    const at = nowIso();
    Object.assign(record, { status: 'completed', result: entry.result, updated_at: at, completed_at: at });
  }
  return [200, { success: true, ...record }];
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** GET /settings/jobs/{id} and GET /scrapers/jobs/{id}; returns true when taken. */
export function handleAssistJobRoutes(req, _res, url, send) {
  if (req.method !== 'GET') return false;
  const match = url.pathname.match(JOB_READ);
  if (!match) return false;
  const jobId = decodeSegment(match[2]);
  const [status, payload] = jobId === null
    ? [400, { success: false, error: 'Malformed path parameter' }]
    : readJob(match[1], jobId);
  send(status, payload);
  return true;
}
