/**
 * Prioritization reads every project's documents in ONE batch request
 * (`GET /projects?ids=…`, at most 200 ids each) instead of one `GET /projects/{id}`
 * per project. Read-only, both roles; creates nothing.
 *
 * Given the signed-in user can see N projects (`GET /projects` as the page loads it),
 * When /prioritization loads,
 * Then the page sends exactly ceil(N / 200) batch reads (0 when N is 0), naming every
 * listed project once between them, and NO per-project detail read.
 *
 * Production: part of the default run (`npm run e2e:prod`), or alone:
 *   npx playwright test -c playwright.config.ts tests/prioritization-requests.spec.ts
 * Local dev mock (no auth):
 *   PORT=3318 node mock-server.js &  VITE_API_ENDPOINT=http://localhost:3318 npx vite --port 5318 &
 *   E2E_MOCK=1 E2E_SITE=http://localhost:5318 E2E_API=http://localhost:3318 \
 *     npx playwright test -c playwright.config.ts --project=admin --no-deps tests/prioritization-requests.spec.ts
 */
import { expect, type Request, type Response } from '@playwright/test'
import { test } from '../lib/test'
import { isApi, jsonOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
/** = MAX_PROJECT_DETAIL_BATCH (lambda/api/projects.py, frontend/src/api/projectsApi.ts). */
const MAX_IDS_PER_BATCH = 200

const isBatchRead = (request: Request): boolean =>
  isApi(request, 'GET', /\/projects$/) && new URL(request.url()).searchParams.has('ids')
const isListRead = (response: Response): boolean =>
  isApi(response, 'GET', /\/projects$/) && !new URL(response.url()).searchParams.has('ids')
// `/projects/prioritization` is the score read, not a project.
const isPerProjectRead = (request: Request): boolean =>
  isApi(request, 'GET', /\/projects\/[^/]+$/) && !new URL(request.url()).pathname.endsWith('/projects/prioritization')

function listedIds(body: Record<string, unknown>): string[] {
  const projects = Array.isArray(body['projects']) ? body['projects'] : []
  return projects.flatMap((project: unknown) => {
    const id = isRecord(project) ? project['project_id'] : undefined
    return typeof id === 'string' ? [id] : []
  })
}

test('Prioritization loads every project in one batch request per 200 ids', async ({ page }) => {
  const batchReads: Request[] = []
  const perProjectReads: Request[] = []
  page.on('request', (request) => {
    if (isBatchRead(request)) batchReads.push(request)
    if (isPerProjectRead(request)) perProjectReads.push(request)
  })

  const list = page.waitForResponse(isListRead)
  await page.goto(site('/prioritization'), { waitUntil: 'domcontentloaded' })
  const ids = listedIds(await jsonOf(await list))
  await settle(page, 1000)

  expect(batchReads).toHaveLength(Math.ceil(ids.length / MAX_IDS_PER_BATCH))
  const requested = batchReads.flatMap((request) => (new URL(request.url()).searchParams.get('ids') ?? '').split(','))
  expect([...requested].sort()).toStrictEqual([...ids].sort())
  expect(perProjectReads.map((request) => new URL(request.url()).pathname)).toStrictEqual([])
})
