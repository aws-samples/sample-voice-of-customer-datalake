/**
 * QA track s1, part 2 (E2E_TRACK=s1 only; runs after s1-a-data.spec.ts):
 *  3. The assistant (floating + /chat) answers "What are customers saying about
 *     Zebrafin?" from the ten imported comments: judged by the tool calls and
 *     tool results in the SSE stream, not only by the prose.
 *  4. Chat writes and reads: create a project through an approval card (proved by
 *     the API), read it back, and read settings (brand, categories, models)
 *     compared with GET /settings/*.
 *  5. Session recovery: reload mid-stream and after completion; reopen from the
 *     history in a fresh browser context.
 *  6. The same as `e2e-user` (non-admin): write-tool permission behaviour.
 * Finally the Lambda REPORT lines of every s1 step window.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type BrowserContext, type Page, type Response } from '@playwright/test'
import { prepareContext, test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import {
  ask, approve, conversationLog, decline, lastApprovalCard, mentioned, newChat, openFloating, sendOnly,
} from '../lib/assistant'
import { readWindows, reportLines, statsOf, type ReportLine } from '../lib/cloudwatch'
import { OUT_DIR, SCREENS_DIR, storageStatePath, type Role } from '../lib/env'
import { isApi, jsonOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'
import { installSseTap, streamLine, streamRuns, writeStreamEvidence, type StreamSummary } from '../lib/sse'
import type { StepRecorder } from '../lib/recorder'
import { ANSWER_STEMS, COMMENTS, NAME, readState, s1Only, s1Step, snippet, writeState } from './s1-shared'

const ZEBRAFIN_QUESTION = 'What are customers saying about Zebrafin?'
const FEEDBACK_TOOLS = ['search_feedback', 'list_feedback', 'get_urgent_feedback', 'get_feedback_item', 'get_entities']
/** Above this the brief counts a response as "> 10 s without streaming progress". */
const MAX_SILENCE_MS = 10_000

const chatLambdas = ['chat-stream', 'chat-api', 'metrics-api', 'projects-api', 'settings-api']

/** `{project: {...}}` (GET/POST /projects) → the project record. */
function projectOf(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body['project']) ? body['project'] : undefined
}

/**
 * Model versions the answer names ("Sonnet 5.5", "claude-opus-4-8") whose
 * version number appears nowhere in GET /settings/model: claims to check by hand.
 */
function unverifiedModels(answer: string, settingsModel: unknown): { claimed: string[]; unverified: string[] } {
  const truth = JSON.stringify(settingsModel).toLowerCase()
  const claimed = [...new Set(answer.match(/(?:claude[\s-]*)?(?:sonnet|opus|haiku)[\s-]*\d+(?:[.-]\d+)?/gi) ?? [])]
  const unverified = claimed.filter((m) => {
    const version = /\d+(?:[.-]\d+)?/.exec(m)?.[0] ?? ''
    return version === '' || !(truth.includes(version) || truth.includes(version.replace('.', '-')))
  })
  return { claimed, unverified }
}

async function newPage(browser: Browser, role: Role): Promise<{ context: BrowserContext; page: Page }> {
  const context = prepareContext(await browser.newContext({ storageState: storageStatePath(role), viewport: { width: 1440, height: 900 } }), role)
  const page = await context.newPage()
  await installSseTap(page)
  return { context, page }
}

/** Notes, evidence file and the common stream checks (HTTP 200, no RUN_ERROR, progress within 10 s). */
function judgeStream(r: StepRecorder, label: string, summary: StreamSummary): void {
  const file = writeStreamEvidence(label, summary)
  r.note(`${label}: ${streamLine(summary)} (sse evidence ${file})`)
  expect(summary.status, `${label}: /chat/stream status`).toBe(200)
  expect(summary.runError, `${label}: RUN_ERROR`).toBeNull()
  expect(summary.error, `${label}: stream read error`).toBeNull()
  expect(summary.maxGapMs, `${label}: longest silence in the stream`).toBeLessThan(MAX_SILENCE_MS)
}

/** The tool results that quote the imported comments, and which comments they quote. */
function citedComments(summary: StreamSummary): { tools: string[]; keys: string[] } {
  const tools: string[] = []
  const keys = new Set<string>()
  for (const call of summary.toolCalls) {
    const result = call.result ?? ''
    const hits = COMMENTS.filter((c) => result.includes(snippet(c.text)))
    if (hits.length > 0) tools.push(`${call.name}(${hits.length})`)
    for (const c of hits) keys.add(c.key)
  }
  return { tools, keys: [...keys] }
}

function recordConversation(save: { status: number; id: string } | null, label: string, role: Role = 'admin'): void {
  if (save !== null && save.status < 300 && save.id !== '') recordCreated('conversation', save.id, `${NAME.project} ${label}`, role)
}

/** Validates an answer about Zebrafin against the ten comments; returns the cited comment keys. */
function judgeZebrafinAnswer(r: StepRecorder, summary: StreamSummary): string[] {
  const used = summary.toolCalls.map((c) => c.name)
  const cited = citedComments(summary)
  const stems = mentioned(summary.answer, ANSWER_STEMS)
  r.note(`tools used: ${used.join(', ') || 'none'}; tool results quoting the comments: ${cited.tools.join(', ') || 'none'} (${cited.keys.length}/10 comments)`)
  r.note(`answer mentions: ${stems.join(', ')}; answer head: ${summary.answer.slice(0, 400).replace(/\s+/g, ' ')}`)
  expect(used.some((n) => FEEDBACK_TOOLS.includes(n)), 'the assistant must look the feedback up').toBe(true)
  expect(cited.keys.length, 'tool results must contain the imported comments').toBeGreaterThanOrEqual(5)
  expect(summary.answer).toMatch(/Zebrafin/i)
  expect(stems.length, 'the answer must cite specific complaints from the comments').toBeGreaterThanOrEqual(4)
  return cited.keys
}

test.describe('s1 assistant', () => {
  test.beforeEach(({}, testInfo) => s1Only(testInfo))

  test('S1-T5 assistant answers about Zebrafin from the imported comments (floating + /chat)', async ({ browser }) => {
    test.setTimeout(480_000)
    test.skip((readState().items ?? []).length !== COMMENTS.length, 'the ten comments are not imported')
    const { context, page } = await newPage(browser, 'admin')
    try {
      await s1Step(page, '09-assistant-floating-zebrafin', chatLambdas, async (r) => {
        await page.goto(site('/'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await openFloating(page)
        await newChat(page)
        const { summary, save } = await ask(page, ZEBRAFIN_QUESTION)
        judgeStream(r, 'floating-zebrafin', summary)
        judgeZebrafinAnswer(r, summary)
        r.note(`conversation save: ${save === null ? 'none' : `${save.status} ${save.id}`}`)
        recordConversation(save, 'floating zebrafin')
        expect(save?.status).toBe(200)
        await expect(conversationLog(page)).toContainText(/Zebrafin/i)
      })

      await s1Step(page, '10-assistant-chat-page-zebrafin', chatLambdas, async (r) => {
        await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await newChat(page)
        const { summary, save } = await ask(page, `${ZEBRAFIN_QUESTION} List each specific problem and how many comments mention it.`)
        judgeStream(r, 'chat-page-zebrafin', summary)
        judgeZebrafinAnswer(r, summary)
        recordConversation(save, 'chat page zebrafin')
        expect(save?.status).toBe(200)
        await expect(conversationLog(page)).toContainText(/Zebrafin/i)
      })
    } finally {
      await context.close()
    }
  })

  test('S1-T6 chat creates a project (approval card), reads it back, reads settings', async ({ browser }) => {
    test.setTimeout(600_000)
    const { context, page } = await newPage(browser, 'admin')
    try {
      await s1Step(page, '11-chat-create-project', chatLambdas, async (r) => {
        await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await newChat(page)
        const prompt = `Create a new project named "${NAME.project}" with the description "e2e-qa research on Zebrafin aquarium complaints". Use the create project tool.`
        const first = await ask(page, prompt)
        judgeStream(r, 'create-project-propose', first.summary)
        expect(first.summary.toolCalls.map((c) => c.name)).toContain('create_project')
        expect(first.summary.interrupted, 'the run must stop for approval').toBe(true)
        const card = lastApprovalCard(page)
        await expect(card).toBeVisible()
        await expect(card).toContainText(NAME.project)
        await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-s1-11-approval-card.png') })
        const result = await approve(page, (res: Response) => isApi(res, 'POST', /\/projects$/))
        expect(result.write, 'approving must POST /projects').not.toBeNull()
        const written = result.write === null ? {} : await jsonOf(result.write)
        const projectId = stringField(projectOf(written), 'project_id', 'id')
        r.note(`approved: POST /projects -> ${result.write?.status() ?? '?'} id=${projectId ?? '?'}`)
        expect(projectId).toBeTruthy()
        if (projectId === undefined) return
        recordCreated('project', projectId, NAME.project)
        judgeStream(r, 'create-project-resume', result.summary)
        const check = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId)}`)
        const checked = projectOf(check.body)
        r.note(`GET /projects/{id} -> ${check.status} name=${stringField(checked, 'name') ?? '?'}`)
        expect(check.status).toBe(200)
        expect(stringField(checked, 'name')).toBe(NAME.project)
        recordConversation(result.save, 'create project')
        writeState({ projectId, projectThreadId: result.save?.id, projectThreadTitle: prompt.slice(0, 40) })
        // An executed card collapses into a tool chip; the reply names the new id.
        await expect(page.getByTestId('approval-card')).toHaveCount(0)
        await expect(conversationLog(page)).toContainText(projectId)
      })

      const { projectId } = readState()
      test.skip(projectId === undefined, 'no project: the create step failed')
      await s1Step(page, '12-chat-read-project', chatLambdas, async (r) => {
        const detail = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId ?? '')}`)
        const project = projectOf(detail.body)
        const { summary, save } = await ask(page, `Look up the project named "${NAME.project}" and tell me its project id, its description and when it was created.`)
        judgeStream(r, 'read-project', summary)
        const used = summary.toolCalls.map((c) => c.name)
        r.note(`tools: ${used.join(', ')}; answer: ${summary.answer.slice(0, 500).replace(/\s+/g, ' ')}`)
        expect(used.some((n) => n === 'get_project' || n === 'list_projects')).toBe(true)
        expect(summary.answer).toContain(projectId ?? '')
        expect(summary.answer).toMatch(/Zebrafin aquarium complaints/i)
        const created = stringField(project, 'created_at') ?? ''
        r.note(`API created_at=${created}`)
        if (created !== '') expect(summary.answer).toContain(created.slice(0, 4))
        recordConversation(save, 'read project')
      })

      await s1Step(page, '13-chat-read-settings', [...chatLambdas, 'settings-api'], async (r) => {
        const brand = await apiCall('admin', 'GET', '/settings/brand')
        const categories = await apiCall('admin', 'GET', '/settings/categories')
        const model = await apiCall('admin', 'GET', '/settings/model')
        const brandName = isRecord(brand.body) ? stringField(brand.body, 'brand_name') ?? '' : ''
        const categoryNames = listOf(categories.body, 'categories').map((c) => stringField(c, 'name') ?? '').filter((n) => n !== '')
        fs.writeFileSync(path.join(OUT_DIR, 'settings-truth.json'), JSON.stringify({ brand: brand.body, categories: categories.body, model: model.body }, null, 2))
        r.note(`GET /settings/brand -> ${brand.status} brand_name=${brandName}; /settings/categories -> ${categories.status} ${categoryNames.length} categories; /settings/model -> ${model.status}`)
        // The settings tools load only on the Settings page (PAGE_TOOL_PACKS.settings, admin-only).
        await page.goto(site('/admin?tab=brand'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await openFloating(page)
        await newChat(page)
        const { summary, save } = await ask(page, 'What are our brand settings (brand name and the other brand fields), which feedback categories are configured, and which AI model is configured for each AI surface? Use your tools; do not guess.')
        judgeStream(r, 'read-settings', summary)
        const used = summary.toolCalls.map((c) => c.name)
        const lower = summary.answer.toLowerCase()
        const named = categoryNames.filter((n) => lower.includes(n.toLowerCase()) || lower.includes(n.replace(/_/g, ' ').toLowerCase()))
        r.note(`tools: ${used.join(', ')}; categories named ${named.length}/${categoryNames.length}; brand named: ${brandName !== '' && summary.answer.includes(brandName)}`)
        const { claimed, unverified } = unverifiedModels(summary.answer, model.body)
        r.note(`models claimed: ${claimed.join(', ') || 'none'}; not in GET /settings/model: ${unverified.join(', ') || 'none'}`)
        r.note(`answer: ${summary.answer.slice(0, 900).replace(/\s+/g, ' ')}`)
        recordConversation(save, 'read settings')
        expect(used).toContain('get_brand_settings')
        expect(used.some((n) => n === 'get_categories_config' || n === 'list_categories')).toBe(true)
        if (brandName !== '') expect(summary.answer).toContain(brandName)
        expect(named.length).toBeGreaterThanOrEqual(Math.min(3, categoryNames.length))
        expect(unverified, 'the answer must not invent model settings').toEqual([])
      })
    } finally {
      await context.close()
    }
  })

  test('S1-T7 session recovery: reload mid-stream, reload after completion, history in a fresh context', async ({ browser }) => {
    test.setTimeout(600_000)
    const { context, page } = await newPage(browser, 'admin')
    try {
      await s1Step(page, '14-reload-mid-stream', chatLambdas, async (r) => {
        await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await newChat(page)
        const question = 'Write a detailed, 500-word analysis of all Zebrafin feedback: group the complaints, quote each comment and suggest a fix for each.'
        const index = await sendOnly(page, question)
        await page.waitForFunction((i) => (window.__e2eSse?.[i]?.chunks ?? []).some((c) => c.text.includes('TEXT_MESSAGE_CONTENT')), index, { timeout: 120_000, polling: 200 })
        const before = (await streamRuns(page))[index]
        const threadId = before?.threadId ?? ''
        const partial = before?.chunks.length ?? 0
        await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-s1-14-before-reload.png') })
        const reloadAt = Date.now()
        r.note(`reloading mid-stream: thread=${threadId} after ${partial} chunks (${Date.now() - (before?.sentAtEpochMs ?? Date.now())}ms after send)`)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await settle(page, 3_000)
        const logText = (await conversationLog(page).innerText().catch(() => '')).trim()
        const restoredInUi = logText.includes(question.slice(0, 40))
        const runsAfterReload = (await streamRuns(page)).length
        r.note(`after reload: question shown=${restoredInUi}; new stream runs started by the page=${runsAfterReload}`)
        const now = await apiCall('admin', 'GET', `/chat/conversations/${encodeURIComponent(threadId)}`)
        r.note(`GET /chat/conversations/{thread} right after reload -> ${now.status}`)
        // Give a server-side run time to finish, then look again: is anything persisted later?
        await page.waitForTimeout(60_000)
        const later = await apiCall('admin', 'GET', `/chat/conversations/${encodeURIComponent(threadId)}`)
        const messages = isRecord(later.body) && Array.isArray(later.body['messages']) ? later.body['messages'].length : 0
        r.note(`GET /chat/conversations/{thread} 60 s later -> ${later.status} messages=${messages}`)
        const list = await apiCall('admin', 'GET', '/chat/conversations/_list?kind=assistant')
        const listed = listOf(list.body, 'conversations').concat(listOf(list.body, 'sessions')).some((s) => stringField(s, 'id', 'conversation_id') === threadId)
        r.note(`listed in history: ${listed}`)
        fs.writeFileSync(path.join(OUT_DIR, 'reload-mid-stream.json'), JSON.stringify({ threadId, reloadAt, partialChunks: partial, restoredInUi, statusNow: now.status, statusLater: later.status, messagesLater: messages, listed }, null, 2))
        if (later.status === 200) recordCreated('conversation', threadId, `${NAME.project} mid-stream`)
        // The brief's expectation: the conversation survives a reload (soft: later steps still run).
        if (!restoredInUi && later.status !== 200) throw new Error('a reload mid-stream lost the conversation: neither the question nor the partial answer was persisted')
      }, { soft: true })

      const completed = { id: '', answerHead: '' }
      await s1Step(page, '15-reload-after-completion', chatLambdas, async (r) => {
        await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await newChat(page)
        const { summary, save } = await ask(page, 'In one sentence: which Zebrafin feature do customers praise?')
        judgeStream(r, 'reload-after-completion', summary)
        recordConversation(save, 'reload after completion')
        expect(save?.status).toBe(200)
        const id = save?.id ?? ''
        const restore = page.waitForResponse((res) => isApi(res, 'GET', new RegExp(`/chat/conversations/${id}$`)), { timeout: 30_000 }).catch(() => null)
        await page.reload({ waitUntil: 'domcontentloaded' })
        const restored = await restore
        r.note(`after reload: GET /chat/conversations/${id} -> ${restored?.status() ?? 'not requested'}`)
        expect(restored?.status()).toBe(200)
        await expect(conversationLog(page)).toContainText('which Zebrafin feature do customers praise')
        const answerHead = summary.answer.replace(/[*_`#]/g, '').split(/\s+/).slice(0, 4).join(' ')
        await expect(conversationLog(page)).toContainText(answerHead)
        r.note(`restored transcript contains the question and the answer head "${answerHead}"`)
        completed.id = id
        completed.answerHead = answerHead
      })

      test.skip(completed.id === '', 'step 15 saved no conversation to reopen')
      const fresh = await newPage(browser, 'admin')
      try {
        await s1Step(fresh.page, '16-history-fresh-context', chatLambdas, async (r) => {
          await fresh.page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
          await settle(fresh.page, 1_500)
          const history = fresh.page.getByRole('list', { name: 'History' }).filter({ visible: true }).first()
          await expect(history).toBeVisible()
          // Titles are the first user message, cut to ~50 characters with "…".
          const row = history.getByRole('button', { name: /^In one sentence: which Zebrafin feature/ }).first()
          await expect(row).toBeVisible({ timeout: 20_000 })
          const opened = fresh.page.waitForResponse((res) => isApi(res, 'GET', new RegExp(`/chat/conversations/${completed.id}$`)), { timeout: 30_000 })
          await row.click()
          const res = await opened
          r.note(`fresh context (no local state), history row clicked: GET /chat/conversations/${completed.id} -> ${res.status()}`)
          expect(res.status()).toBe(200)
          await expect(conversationLog(fresh.page)).toContainText('which Zebrafin feature do customers praise')
          await expect(conversationLog(fresh.page)).toContainText(completed.answerHead)
        })
      } finally {
        await fresh.context.close()
      }
    } finally {
      await context.close()
    }
  })

  test('S1-T8 e2e-user (non-admin): short chat and write-tool permissions', async ({ browser }) => {
    test.setTimeout(720_000)
    const { context, page } = await newPage(browser, 'user')
    const step = (name: string, action: (r: StepRecorder) => Promise<void>, expected4xx?: { status: number; path: RegExp }): Promise<void> =>
      s1Step(page, name, chatLambdas, action, { role: 'user', expected4xx })
    try {
      await step('17-user-chat', async (r) => {
        await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await newChat(page)
        const { summary, save } = await ask(page, ZEBRAFIN_QUESTION)
        judgeStream(r, 'user-zebrafin', summary)
        const cited = citedComments(summary)
        r.note(`user: tools ${summary.toolCalls.map((c) => c.name).join(', ')}; comments in tool results ${cited.keys.length}/10; packs=${JSON.stringify(isRecord(summary.context) ? summary.context['packs'] : null)}`)
        recordConversation(save, 'user zebrafin', 'user')
      })

      await step('18-user-create-project', async (r) => {
        const first = await ask(page, `Create a new project named "${NAME.userProject}" with the description "e2e-qa user permission check".`)
        judgeStream(r, 'user-create-project-propose', first.summary)
        expect(first.summary.interrupted).toBe(true)
        const card = lastApprovalCard(page)
        const approveButton = card.getByRole('button', { name: 'Approve', exact: true })
        r.note(`user create_project card: approve enabled=${await approveButton.isEnabled()} adminOnly note=${await card.getByText('Only administrators').isVisible().catch(() => false)}`)
        await expect(approveButton).toBeEnabled()
        const result = await approve(page, (res: Response) => isApi(res, 'POST', /\/projects$/))
        const written = result.write === null ? {} : await jsonOf(result.write)
        const userProjectId = stringField(projectOf(written), 'project_id', 'id')
        r.note(`user approved: POST /projects -> ${result.write?.status() ?? '?'} id=${userProjectId ?? '?'}`)
        expect(result.write?.status()).toBeLessThan(300)
        if (userProjectId !== undefined) {
          recordCreated('project', userProjectId, NAME.userProject)
          writeState({ userProjectId })
          const asUser = await apiCall('user', 'GET', `/projects/${encodeURIComponent(userProjectId)}`)
          const owner = stringField(projectOf(asUser.body), 'owner_sub', 'owner')
          r.note(`GET /projects/{id} as user -> ${asUser.status} owner=${owner ?? '?'}`)
          expect(asUser.status).toBe(200)
        }
        recordConversation(result.save, 'user create project', 'user')
      })

      await step('19-user-admin-only-write', async (r) => {
        const { summary, save } = await ask(page, 'Change our brand name in the settings to "e2e-qa brand". Use the save brand settings tool.')
        judgeStream(r, 'user-brand-write', summary)
        const used = summary.toolCalls.map((c) => c.name)
        r.note(`tools: ${used.join(', ') || 'none'}; interrupted=${summary.interrupted}; answer: ${summary.answer.slice(0, 400).replace(/\s+/g, ' ')}`)
        recordConversation(save, 'user brand write', 'user')
        if (summary.interrupted) {
          const card = lastApprovalCard(page)
          const enabled = await card.getByRole('button', { name: 'Approve', exact: true }).isEnabled()
          r.note(`an approval card was offered to a non-admin: approve enabled=${enabled}; declining`)
          await decline(page)
          expect(enabled, 'a non-admin must not be able to approve save_brand_settings').toBe(false)
        }
        expect(used).not.toContain('save_brand_settings')
      })

      const { projectId } = readState()
      await step('20-user-foreign-project-write', async (r) => {
        if (projectId === undefined) throw new Error('no admin project from S1-T6 to target')
        const before = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId ?? '')}`)
        const descBefore = stringField(projectOf(before.body), 'description')
        // On the project's own page the project pack (update_project…) would load:
        // the stream must drop it for a caller who cannot even view the project.
        await page.goto(site(`/projects/${encodeURIComponent(projectId)}?tab=overview`), { waitUntil: 'domcontentloaded' })
        await settle(page, 1_500)
        await page.screenshot({ path: path.join(SCREENS_DIR, 'user-dark-s1-20-foreign-project-page.png') })
        await openFloating(page)
        await newChat(page)
        const { summary, save } = await ask(page, `Update the description of this project (${projectId}) to "changed by e2e-user".`)
        r.note(`assistant context on the foreign project page: ${JSON.stringify(summary.context).slice(0, 300)}`)
        judgeStream(r, 'user-foreign-project-write', summary)
        r.note(`tools: ${summary.toolCalls.map((c) => c.name).join(', ') || 'none'}; interrupted=${summary.interrupted}; answer: ${summary.answer.slice(0, 400).replace(/\s+/g, ' ')}`)
        recordConversation(save, 'user foreign project write', 'user')
        if (summary.interrupted) {
          // Defence in depth: approve, and REST must refuse a private project the user cannot view.
          const result = await approve(page, (res: Response) => isApi(res, 'PUT', /\/projects\/[^/]+$/))
          r.note(`card offered and approved: PUT /projects/{id} -> ${result.write?.status() ?? 'no request'}`)
          if (result.write !== null) expect(result.write.status()).toBeGreaterThanOrEqual(400)
        }
        const after = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId ?? '')}`)
        const descAfter = stringField(projectOf(after.body), 'description')
        r.note(`admin project description unchanged: ${descAfter === descBefore}`)
        expect(descBefore).toBeDefined()
        expect(descAfter).toBe(descBefore)
      }, { status: 404, path: new RegExp(`^/v1/projects/${projectId ?? 'none'}(/|$)`) })

      await step('21-user-run-scraper-card', async (r) => {
        await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        await openFloating(page)
        await newChat(page)
        const { summary, save } = await ask(page, `Run the scraper named "${NAME.scraper}" now.`)
        judgeStream(r, 'user-run-scraper', summary)
        r.note(`tools: ${summary.toolCalls.map((c) => c.name).join(', ') || 'none'}; interrupted=${summary.interrupted}; answer: ${summary.answer.slice(0, 300).replace(/\s+/g, ' ')}`)
        recordConversation(save, 'user run scraper', 'user')
        if (summary.interrupted) {
          const card = lastApprovalCard(page)
          const approveButton = card.getByRole('button', { name: 'Approve', exact: true })
          const enabled = await approveButton.isEnabled()
          const note = await card.getByText('Only administrators can approve this action').isVisible().catch(() => false)
          r.note(`run_scraper card for a non-admin: approve enabled=${enabled}, admin-only note shown=${note} (never clicked)`)
          await page.screenshot({ path: path.join(SCREENS_DIR, 'user-dark-s1-21-run-scraper-card.png') })
          await decline(page)
          expect(enabled).toBe(false)
          expect(note).toBe(true)
        }
      })
    } finally {
      await context.close()
    }
  })

  test('S1-T9 Lambda REPORT lines for every s1 step window', async () => {
    test.setTimeout(240_000)
    // CloudWatch ingests REPORT lines a few seconds after the invocation ends.
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    const out: Array<{ step: string; window: string; stats: ReturnType<typeof statsOf>[]; lines: ReportLine[] }> = []
    for (const w of readWindows().filter((x) => x.step.startsWith('s1-'))) {
      // reportLines degrades to [] (with a warning) when a log group is unreadable.
      const lines = w.lambdas.flatMap((l) => reportLines(l, w.startMs, w.endMs))
      out.push({ step: w.step, window: `${new Date(w.startMs).toISOString()}..${new Date(w.endMs).toISOString()}`, stats: w.lambdas.map((l) => statsOf(l, lines.filter((x) => x.lambda === l))), lines })
    }
    fs.writeFileSync(path.join(OUT_DIR, 'lambda-reports.json'), JSON.stringify(out, null, 2))
    expect(out.length).toBeGreaterThan(0)
  })
})
