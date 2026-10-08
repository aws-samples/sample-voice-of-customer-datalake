/**
 * P3 — two tabs of one user (E2E-COVERAGE-GAPS I-13). Admin only; e2e-named data.
 *
 * 1. Workflow (an e2e agent's own e2e workflow): both tabs open the Workflow
 *    tab and edit the description; tab A saves ("Saved."), tab B's save of the
 *    stale revision gets the conflict UI ("Someone saved a newer revision
 *    meanwhile." + "Save mine as a copy" / "Load the latest") — no silent
 *    overwrite: the server holds A's text at exactly one revision more. "Load
 *    the latest" then shows A's text in B.
 * 2. Document (a custom document in an e2e project): both tabs open the editor;
 *    tab A saves, tab B's save carries the revision it loaded and gets a 409 and
 *    the conflict UI ("Someone saved a newer version of this document
 *    meanwhile." + "Load the latest" / "Save mine anyway") with its draft kept —
 *    no silent overwrite: the server holds A's text and B made no version. "Load
 *    the latest" then shows A's text in B.
 * 3. Two assistant threads at once: a second conversation is started while the
 *    first is still answering; both finish, each keeps its own answer, neither
 *    shows "Failed".
 *
 * Production cleanup: the agent is archived and its workflow deleted in
 * afterAll; the project goes in the ledger (cleanup deletes it, documents
 * included); conversations are ledger-recorded by lib/test.ts. Under E2E_MOCK
 * the mock's own fixtures are used.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { composer, conversationLog } from '../lib/assistant'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'
import { ensureE2eProject } from '../lib/projects'
import { isApi, roleOf, settle, site } from '../lib/fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENTS: unknown = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../public/locales/en/agents.json'), 'utf8'))

/** `agents.json` string at a dotted key (throws when missing, so a renamed key fails loudly). */
function agentsText(key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), AGENTS)
  if (typeof value !== 'string') throw new Error(`agents.json has no string at ${key}`)
  return value
}

/** Mock fixtures: an agent on a non-built-in workflow, and a project the mock admin can edit. */
const MOCK_AGENT = { agentId: 'ag_8a2f4b6c1d0e', workflowId: 'wf_3b9e1c0d7a42' }
const MOCK_PROJECT = 'proj_1'

const objectOf = (body: unknown, key: string): Record<string, unknown> =>
  isRecord(body) && isRecord(body[key]) ? body[key] : {}

/** The workflow's current revision and description (GET /workflows/{id}). */
async function readWorkflow(id: string): Promise<{ revision: number; description: string }> {
  const workflow = objectOf((await apiCall('admin', 'GET', `/workflows/${encodeURIComponent(id)}`)).body, 'workflow')
  const definition = isRecord(workflow['definition']) ? workflow['definition'] : {}
  const revision = typeof workflow['revision'] === 'number' ? workflow['revision'] : -1
  return { revision, description: typeof definition['description'] === 'string' ? definition['description'] : '' }
}

/** Production: an e2e copy of the built-in workflow and a disabled e2e agent on it. */
async function e2eAgentOnOwnWorkflow(): Promise<{ agentId: string; workflowId: string }> {
  const dup = await apiCall('admin', 'POST', '/workflows/wf_default/duplicate', { name: `${RUN_PREFIX}concurrency-wf` })
  const workflowId = stringField(objectOf(dup.body, 'workflow'), 'workflow_id') ?? ''
  if (dup.status >= 300 || workflowId === '') throw new Error(`POST /workflows/wf_default/duplicate -> ${dup.status}`)
  recordCreated('workflow', workflowId, `${RUN_PREFIX}concurrency-wf`)
  const name = `${RUN_PREFIX}concurrency-agent`
  const agent = await apiCall('admin', 'POST', '/agents', {
    name, description: 'Created by the e2e QA suite; archived at the end of the spec.', workflow_id: workflowId, triggers: [],
  })
  const agentId = stringField(objectOf(agent.body, 'agent'), 'agent_id') ?? ''
  if (agent.status !== 201 || agentId === '') throw new Error(`POST /agents -> ${agent.status}`)
  recordCreated('agent', agentId, name)
  return { agentId, workflowId }
}

const panelOf = (page: Page): Locator => page.getByRole('complementary', { name: agentsText('editor.panel') })
/** projectDetail.json documentModal.conflict — the document editor's stale-save banner. */
const DOC_CONFLICT = 'Someone saved a newer version of this document meanwhile.'

async function openWorkflowTab(page: Page, agentId: string): Promise<void> {
  await page.goto(site(`/agents/${encodeURIComponent(agentId)}?tab=workflow`), { waitUntil: 'domcontentloaded' })
  await settle(page, 600)
  await expect(page.locator('.react-flow__pane')).toBeVisible()
}

async function editDescription(page: Page, text: string): Promise<void> {
  const field = panelOf(page).getByLabel(agentsText('editor.fields.description'))
  await field.fill(text)
  await expect(page.getByText(agentsText('editor.unsaved'))).toBeVisible()
}

const saveButton = (page: Page): Locator => page.getByRole('button', { name: agentsText('editor.save'), exact: true })

/** The stored messages of the caller's conversation `id` ([] when absent). */
async function storedMessages(id: string): Promise<Array<Record<string, unknown>>> {
  const stored = await apiCall('admin', 'GET', `/chat/conversations/${encodeURIComponent(id)}`)
  return isRecord(stored.body) && Array.isArray(stored.body['messages']) ? stored.body['messages'].filter(isRecord) : []
}

/** Opens the Documents tab, selects `title` and opens its editor. */
async function openDocumentEditor(page: Page, projectId: string, title: string): Promise<void> {
  await page.goto(site(`/projects/${encodeURIComponent(projectId)}?tab=documents`), { waitUntil: 'domcontentloaded' })
  await settle(page, 600)
  await page.getByRole('button', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click()
  await page.getByTitle('Edit document').first().click()
}

async function saveDocument(page: Page, content: string): Promise<number> {
  const field = page.getByPlaceholder(/Write your document/)
  await field.fill(content)
  const saved = page.waitForResponse((r) => isApi(r, 'PUT', /\/projects\/[^/]+\/documents\/[^/]+$/))
  await page.getByRole('button', { name: 'Save Changes' }).click()
  return (await saved).status()
}

test.describe('two tabs, one user', () => {
  const cleanup: Array<() => Promise<unknown>> = []
  test.afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => undefined)
  })

  test('project: two creates in the same second both succeed, with different ids', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'one role is enough')
    // Ids were `proj_<YYYYmmddHHMMSS>`: the second of two same-second creates
    // answered 500 (and the fixtures spaced creates 1.1 s apart). Fired together.
    const names = [`${RUN_PREFIX}same-second-a`, `${RUN_PREFIX}same-second-b`]
    const created = await Promise.all(names.map((name) => apiCall('admin', 'POST', '/projects', {
      name, description: 'Created by the e2e suite; deleted at the end of the run.', visibility: 'private',
    })))
    const ids = created.map((result, index) => {
      const id = stringField(objectOf(result.body, 'project'), 'project_id') ?? ''
      if (id !== '' && !MOCK) recordCreated('project', id, names[index] ?? '')
      return { status: result.status, id }
    })
    for (const result of ids) expect(result.status, 'no 500 for the second create').toBeLessThan(300)
    expect(new Set(ids.map((r) => r.id)).size, 'two different project ids').toBe(2)
  })

  test('workflow: the second save of a stale revision gets the conflict UI, no silent overwrite', async ({ page, context }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'workflow writes are admin-only')
    const { agentId, workflowId } = MOCK ? MOCK_AGENT : await e2eAgentOnOwnWorkflow()
    if (!MOCK) {
      cleanup.push(() => apiCall('admin', 'DELETE', `/workflows/${encodeURIComponent(workflowId)}`))
      cleanup.push(() => apiCall('admin', 'DELETE', `/agents/${encodeURIComponent(agentId)}`))
    }
    const before = await readWorkflow(workflowId)
    const tabA = page
    const tabB = await context.newPage()
    await openWorkflowTab(tabA, agentId)
    await openWorkflowTab(tabB, agentId)
    const textA = `${RUN_PREFIX}edited in tab A`
    await editDescription(tabA, textA)
    await editDescription(tabB, `${RUN_PREFIX}edited in tab B`)

    await saveButton(tabA).click()
    await expect(tabA.getByRole('status').filter({ hasText: agentsText('editor.outcome.saved') })).toBeVisible()

    const refused = tabB.waitForResponse((r) => isApi(r, 'PUT', /\/workflows\/[^/]+$/))
    await saveButton(tabB).click()
    expect((await refused).status(), 'the stale save is refused').toBe(409)
    const conflict = tabB.getByRole('alert').filter({ hasText: agentsText('editor.conflict') })
    await expect(conflict).toBeVisible()
    await expect(conflict.getByRole('button', { name: agentsText('editor.conflictSaveAs') })).toBeVisible()

    const after = await readWorkflow(workflowId)
    expect(after.revision, 'exactly one save landed').toBe(before.revision + 1)
    expect(after.description, 'tab A\'s edit is what the server holds').toBe(textA)

    await conflict.getByRole('button', { name: agentsText('editor.conflictReload') }).click()
    await expect(conflict).toHaveCount(0)
    await expect(panelOf(tabB).getByLabel(agentsText('editor.fields.description'))).toHaveValue(textA)
    await tabB.close()
  })

  test('document: the second tab\'s save of a stale revision gets the conflict UI, no silent overwrite', async ({ page, context }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'one role is enough')
    const projectId = MOCK ? MOCK_PROJECT : await ensureE2eProject(`${RUN_PREFIX}concurrency`, 'private')
    const title = `${RUN_PREFIX}concurrent doc`
    const created = await apiCall('admin', 'POST', `/projects/${encodeURIComponent(projectId)}/documents`, { title, content: 'original e2e content' })
    // The API answers `{success, document}`; the mock also echoes a top-level `document_id`.
    const createdDoc = isRecord(created.body) && isRecord(created.body['document']) ? created.body['document'] : undefined
    const documentId = stringField(createdDoc, 'document_id') ?? stringField(isRecord(created.body) ? created.body : undefined, 'document_id') ?? ''
    expect(documentId, `POST documents -> ${created.status}`).not.toBe('')

    const tabB = await context.newPage()
    await openDocumentEditor(page, projectId, title)
    await openDocumentEditor(tabB, projectId, title)
    const textA = `${RUN_PREFIX} content saved in tab A`
    const textB = `${RUN_PREFIX} content saved in tab B`
    expect(await saveDocument(page, textA)).toBe(200)
    expect(await saveDocument(tabB, textB), 'the stale save is refused').toBe(409)

    const conflict = tabB.getByRole('alert').filter({ hasText: DOC_CONFLICT })
    await expect(conflict).toBeVisible()
    await expect(conflict.getByRole('button', { name: 'Save mine anyway' })).toBeVisible()
    await expect(tabB.getByPlaceholder(/Write your document/), 'tab B keeps its draft').toHaveValue(textB)

    const versions = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/versions`)
    expect(versions.status).toBe(200)
    const contents = listOf(versions.body, 'versions').map((v) => stringField(v, 'content') ?? '')
    expect(contents[0], 'tab A\'s edit is what the server holds').toBe(textA)
    expect(contents, 'tab B\'s stale save made no version').not.toContain(textB)

    await conflict.getByRole('button', { name: 'Load the latest' }).click()
    await expect(conflict).toHaveCount(0)
    await expect(tabB.getByPlaceholder(/Write your document/)).toHaveValue(textA)
    await tabB.close()
  })

  test('assistant: two conversations answer at the same time', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'one role is enough (two Bedrock calls)')
    test.setTimeout(240_000)
    const streams: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/chat\/stream$/.test(new URL(r.url()).pathname)) streams.push(r.postData() ?? '')
    })
    await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
    await settle(page, 600)
    const prompts = ['e2e concurrency one: name the most common complaint in five words.', 'e2e concurrency two: name one thing customers praise, in five words.']
    const send = page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).first()
    await composer(page).fill(prompts[0] ?? '')
    await send.click()
    // While the first is still answering, start the second.
    await page.getByRole('button', { name: 'New conversation' }).click()
    await composer(page).fill(prompts[1] ?? '')
    await send.click()
    await expect.poll(() => streams.length, { message: 'two runs started' }).toBe(2)
    const ids = streams.map((body) => {
      const parsed: unknown = JSON.parse(body)
      return isRecord(parsed) && typeof parsed['threadId'] === 'string' ? parsed['threadId'] : ''
    })
    expect(new Set(ids).size, 'two distinct conversations').toBe(2)

    const sidebar = page.getByRole('navigation', { name: 'Conversations' })
    await expect(sidebar.getByText('Running')).toHaveCount(0, { timeout: 200_000 })
    await expect(sidebar.getByText('Failed')).toHaveCount(0)
    for (const [index, prompt] of prompts.entries()) {
      const id = ids[index] ?? ''
      // The SPA saves a conversation after its run ends (in production the stream Lambda saves too): poll.
      await expect.poll(async () => (await storedMessages(id)).map((m) => m['role']), {
        timeout: 30_000, message: `conversation ${index + 1} has its own question and an answer`,
      }).toEqual(expect.arrayContaining(['user', 'assistant']))
      expect((await storedMessages(id)).find((m) => m['role'] === 'user')?.['content']).toBe(prompt)
    }
    // The one in view is the second; it shows its own question, not the first's.
    await expect(conversationLog(page)).toContainText(prompts[1] ?? '')
    await expect(conversationLog(page)).not.toContainText(prompts[0] ?? '')
  })
})
