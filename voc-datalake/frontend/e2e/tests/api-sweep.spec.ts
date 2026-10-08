/**
 * Calls every GET endpoint in the inventory directly with the role's id token
 * and records status + latency + size (never bodies) to
 * OUT_DIR/api-sweep-<role>.json. Real ids come from list calls; where no real
 * id exists a clearly fake one is used and a 4xx is the expected answer.
 * Fails on any 5xx, on a 4xx for a real-id admin call, and when a plain user
 * gets 2xx from an admin-only route.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { breachOf, endpointBudget, enforceBudgets } from '../lib/budgets'
import { OUT_DIR, type Role } from '../lib/env'
import { roleOf } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { cognitoUsernameFor } from '../lib/session'

const FAKE = 'e2e-nonexistent-0000'

interface Probe {
  path: string
  /** A fake id is in the path: 4xx is correct. */
  fake?: boolean
  /** Admin-only route: a plain user must get 401/403/404. */
  adminOnly?: boolean
}

interface Ids {
  project: string; feedback: string; agent: string; workflow: string; form: string; scraper: string
  token: string; conversation: string; username: string; reprocessJob: string; projectJob: string; run: string
}

const first = (body: unknown, key: string, ...idKeys: string[]): string | undefined =>
  stringField(listOf(body, key)[0], ...idKeys)

async function resolveIds(role: Role): Promise<{ ids: Ids; real: Set<keyof Ids> }> {
  const get = async (p: string): Promise<unknown> => (await apiCall(role, 'GET', p)).body
  const [projects, feedback, agents, workflows, forms, scrapers, tokens, convs, reprocess] = await Promise.all([
    get('/projects'), get('/feedback?days=0&limit=1'), get('/agents'), get('/workflows'), get('/feedback-forms'),
    get('/scrapers'), get('/connect/tokens'), get('/chat/conversations/_list'), get('/settings/categories/reprocess'),
  ])
  const found: Partial<Ids> = {
    project: first(projects, 'projects', 'project_id', 'id'),
    feedback: first(feedback, 'items', 'feedback_id', 'id'),
    agent: first(agents, 'items', 'agent_id', 'id'),
    workflow: first(workflows, 'items', 'workflow_id', 'id'),
    form: first(forms, 'forms', 'form_id', 'id'),
    scraper: first(scrapers, 'scrapers', 'id'),
    token: first(tokens, 'tokens', 'token_id', 'id'),
    conversation: first(convs, 'conversations', 'id', 'conversationId') ?? first(convs, 'items', 'id', 'conversationId'),
    username: cognitoUsernameFor(role),
    reprocessJob: isRecord(reprocess) && isRecord(reprocess['job']) ? stringField(reprocess['job'], 'job_id', 'id') : undefined,
  }
  if (found.project !== undefined) {
    found.projectJob = first(await get(`/projects/${found.project}/jobs`), 'jobs', 'job_id', 'id')
  }
  if (found.agent !== undefined) {
    found.run = first(await get(`/agents/${found.agent}/runs`), 'items', 'run_id', 'id')
  }
  const real = new Set<keyof Ids>()
  const pick = (k: keyof Ids): string => {
    const v = found[k]
    if (v !== undefined) real.add(k)
    return encodeURIComponent(v ?? FAKE)
  }
  const ids: Ids = {
    project: pick('project'), feedback: pick('feedback'), agent: pick('agent'), workflow: pick('workflow'),
    form: pick('form'), scraper: pick('scraper'), token: pick('token'), conversation: pick('conversation'),
    username: pick('username'), reprocessJob: pick('reprocessJob'), projectJob: pick('projectJob'), run: pick('run'),
  }
  return { ids, real }
}

function probes(ids: Ids, real: Set<keyof Ids>): Probe[] {
  const r = (k: keyof Ids): boolean => !real.has(k)
  const d = 'days=30'
  return [
    { path: `/feedback?${d}&limit=20` }, { path: `/feedback/${ids.feedback}`, fake: r('feedback') },
    { path: `/feedback/urgent?${d}&limit=10` }, { path: `/feedback/search?q=delivery&${d}&limit=10` },
    { path: `/feedback/${ids.feedback}/similar?limit=5`, fake: r('feedback') }, { path: `/feedback/entities?${d}` }, { path: '/feedback/access' },
    { path: `/metrics/summary?${d}` }, { path: `/metrics/sentiment?${d}` }, { path: `/metrics/categories?${d}` },
    { path: `/metrics/sources?${d}` }, { path: `/metrics/personas?${d}` }, { path: `/metrics/github?${d}` },
    { path: '/sources/status' }, { path: '/integrations/status', adminOnly: true },
    // github_issues is single-config: 400 "does not support multiple app configs" is its correct answer.
    { path: '/integrations/github_issues/apps', adminOnly: true, fake: true },
    { path: '/settings/brand' }, { path: '/settings/model' }, { path: '/settings/resolved-problems' }, { path: '/settings/categories' },
    { path: '/settings/categories/reprocess' }, { path: `/settings/categories/reprocess/${ids.reprocessJob}`, fake: r('reprocessJob') },
    { path: '/settings/company-context' }, { path: '/settings/my-context' }, { path: '/settings/design-system' },
    { path: '/scrapers' }, { path: '/scrapers/templates' }, { path: `/scrapers/${ids.scraper}/status`, fake: r('scraper') },
    { path: `/scrapers/${ids.scraper}/runs`, fake: r('scraper') }, { path: `/scrapers/manual/parse/${FAKE}`, fake: true },
    { path: '/projects' }, { path: `/projects/${ids.project}`, fake: r('project') }, { path: `/projects/${ids.project}/members`, fake: r('project') },
    { path: `/projects/${ids.project}/members/candidates?q=e2e`, fake: r('project') }, { path: `/projects/${ids.project}/jobs`, fake: r('project') },
    { path: `/projects/${ids.project}/jobs/${ids.projectJob}`, fake: r('project') || r('projectJob') },
    { path: `/projects/${ids.project}/product-context`, fake: r('project') }, { path: `/projects/${ids.project}/product-docs`, fake: r('project') },
    { path: `/projects/${ids.project}/prototypes/${FAKE}/pins`, fake: true }, { path: '/projects/prioritization' },
    { path: `/voting-sessions/${FAKE}`, fake: true }, { path: `/voting-sessions/${FAKE}/config`, fake: true },
    { path: '/feedback-forms' }, { path: `/feedback-forms/${ids.form}`, fake: r('form') }, { path: `/feedback-forms/${ids.form}/stats`, fake: r('form') },
    { path: `/feedback-forms/${ids.form}/submissions?limit=5`, fake: r('form') }, { path: `/feedback-forms/${ids.form}/config`, fake: r('form') },
    { path: '/users', adminOnly: true }, { path: `/users/${ids.username}/category-access`, adminOnly: true },
    { path: `/logs/validation?days=7` }, { path: `/logs/processing?days=7` }, { path: `/logs/scraper/${ids.scraper}?days=7`, fake: r('scraper') },
    { path: '/logs/summary?days=7' },
    { path: '/s3-import/sources' }, { path: '/s3-import/files' },
    { path: '/data-explorer/buckets', adminOnly: true }, { path: '/data-explorer/s3?prefix=raw/', adminOnly: true },
    { path: `/data-explorer/s3/preview?key=raw/${FAKE}.json`, adminOnly: true, fake: true }, { path: '/data-explorer/stats', adminOnly: true },
    { path: '/memory?scope=company' }, { path: '/memory?scope=personal' }, { path: '/memory/review' }, { path: `/memory/imports/${FAKE}`, fake: true },
    { path: '/memory/stats' },
    { path: '/agents' }, { path: `/agents/${ids.agent}`, fake: r('agent') }, { path: `/agents/${ids.agent}/runs`, fake: r('agent') },
    { path: `/agents/${ids.agent}/runs/${ids.run}`, fake: r('agent') || r('run') },
    { path: `/agents/${ids.agent}/runs/${ids.run}/events?after=0`, fake: r('agent') || r('run') },
    { path: '/workflows' }, { path: `/workflows/${ids.workflow}`, fake: r('workflow') }, { path: `/workflows/${ids.workflow}/export`, fake: r('workflow') },
    { path: '/connect/tokens' }, { path: `/connect/tokens/${ids.token}`, fake: r('token') },
    { path: '/chat/conversations/_list' }, { path: '/chat/conversations/_list?kind=assistant' },
    { path: `/chat/conversations/${ids.conversation}`, fake: r('conversation') },
  ]
}

interface SweepRow { path: string; status: number; ms: number; bytes: number; fake: boolean; adminOnly: boolean; verdict: string; message: string }

function verdictOf(role: Role, probe: Probe, status: number): string {
  if (status >= 500) return 'FAIL-5xx'
  if (role === 'user' && probe.adminOnly === true) return status >= 400 ? 'ok-denied' : 'FAIL-not-denied'
  if (status < 300) return 'ok'
  if (probe.fake === true && status >= 400 && status < 500) return 'ok-expected-4xx'
  if (role === 'user' && (status === 403 || status === 404)) return 'ok-denied'
  return `FAIL-${status}`
}

test('api sweep: every GET endpoint', async ({}, testInfo) => {
  test.setTimeout(600_000)
  const role = roleOf(testInfo)
  const { ids, real } = await resolveIds(role)
  const rows: SweepRow[] = []
  for (const probe of probes(ids, real)) {
    const res = await apiCall(role, 'GET', probe.path)
    const message = res.status >= 400 && isRecord(res.body) ? String(res.body['message'] ?? res.body['error'] ?? '').slice(0, 160) : ''
    rows.push({
      path: probe.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{20,}/g, '{id}'),
      status: res.status, ms: res.ms, bytes: res.bytes, fake: probe.fake === true, adminOnly: probe.adminOnly === true,
      verdict: verdictOf(role, probe, res.status), message,
    })
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `api-sweep-${role}.json`), JSON.stringify({ role, at: new Date().toISOString(), resolved: [...real], rows }, null, 2))
  const failures = rows.filter((row) => row.verdict.startsWith('FAIL'))
  expect(failures, 'endpoints that failed').toEqual([])
  enforceBudgets(testInfo, rows.map((row) => breachOf(`GET ${row.path} (${role})`, row.ms, endpointBudget(row.path))))
})
