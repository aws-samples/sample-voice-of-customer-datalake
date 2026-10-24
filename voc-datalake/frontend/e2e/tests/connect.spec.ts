/**
 * Connect (R20): global MCP tokens, both roles, each on its own tokens only.
 *
 * - UI: mint a READ token on /connect ("Create a token": name, Read only, the
 *   shortest expiry offered), the one-time banner shows it, the row reads Active /
 *   Read only; `POST /mcp/global` `tools/list` with it → 200 and tools; Revoke →
 *   "Revoke this token?" → Revoke → the row reads Revoked and the same call → 401
 *   with a Bearer challenge.
 * - API: a 1-day read token (`expires_in_days: 1`, below the UI's choices) expires
 *   one day out, works, and stops working the moment it is revoked.
 *
 * Every token is recorded in the ledger as its owner's the moment its id is known,
 * so cleanup revokes it whatever fails. The secret is held in memory only: never
 * logged, never written to the evidence. Production-safe (e2e-named, revoked).
 *
 * Local dev mock (no `/mcp/global` route there, so the MCP calls skip):
 *   E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 \
 *     npx playwright test -c playwright.config.ts --project=admin --no-deps tests/connect.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX, type Role } from '../lib/env'
import { isApi, jsonOf, roleOf, runStep, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'
import { mcpToolsList, type McpAnswer } from '../lib/mcp'

const DAY_MS = 24 * 60 * 60_000
/** Clock skew plus request time allowed around the 1-day expiry. */
const EXPIRY_SLACK_MS = 10 * 60_000
/** JSON-RPC code of a missing, expired or revoked token (mcp_global_handler.py). */
const UNAUTHORIZED_CODE = -32001

const tokenRow = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: 'My tokens' }).getByRole('listitem').filter({ hasText: name })

/** The token works: `tools/list` answers 200 with at least one tool. */
function expectWorks(answer: McpAnswer): void {
  expect(answer.status, 'tools/list with a live token').toBe(200)
  expect(answer.toolCount ?? 0).toBeGreaterThan(0)
}

/**
 * The token is dead: 401 and the JSON-RPC unauthorized code. The Bearer challenge
 * is a SOFT check: API Gateway (REST, Lambda proxy) renames the handler's
 * `WWW-Authenticate` to `x-amzn-Remapped-WWW-Authenticate`, so on production an MCP
 * client never sees it (finding, 2.14.00). It stays red until that is fixed.
 */
function expectRefused(answer: McpAnswer): void {
  expect(answer.status, 'tools/list with a revoked token').toBe(401)
  expect(answer.errorCode).toBe(UNAUTHORIZED_CODE)
  expect.soft(answer.wwwAuthenticate ?? '', 'WWW-Authenticate reaches the client (API Gateway remaps it)').toMatch(/^Bearer /)
}

test.describe('connect: global MCP tokens', () => {
  test('mint a read token in the UI, use it, revoke it', async ({ page }, testInfo) => {
    const role: Role = roleOf(testInfo)
    const name = `${RUN_PREFIX}connect-ui-${role}`
    let secret = ''
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'connect-mint-revoke',
      action: async (r) => {
        await page.goto(site('/connect'), { waitUntil: 'domcontentloaded' })
        await settle(page, 500)
        const form = page.getByRole('region', { name: 'Create a token' })
        await form.getByLabel('Name').fill(name)
        await form.getByRole('radio', { name: /^Read only/ }).check()
        await form.getByLabel('Expires after').selectOption('7')
        const minted = page.waitForResponse((res) => isApi(res, 'POST', /\/connect\/tokens$/))
        await form.getByRole('button', { name: 'Create token' }).click()
        const response = await minted
        const id = stringField(await jsonOf(response), 'token_id')
        r.note(`POST /connect/tokens -> ${response.status()} token_id=${id ?? '?'}`)
        expect(response.status()).toBeLessThan(300)
        if (id === undefined) throw new Error('POST /connect/tokens answered no token_id')
        recordCreated('token', id, name, role)

        secret = (await page.getByTestId('connect-new-token').innerText()).trim()
        expect(secret.startsWith('voc_'), 'the one-time banner shows a voc_ token').toBe(true)
        await page.getByRole('button', { name: 'I have copied it' }).click()
        await expect(page.getByTestId('connect-new-token')).toHaveCount(0)
        await expect(tokenRow(page, name)).toContainText('Active')
        await expect(tokenRow(page, name)).toContainText('Read only')

        if (!MOCK) expectWorks(await mcpToolsList(secret))

        const revoked = page.waitForResponse((res) => isApi(res, 'DELETE', new RegExp(`/connect/tokens/${id}$`)))
        await tokenRow(page, name).getByRole('button', { name: 'Revoke' }).click()
        const dialog = dialogNamed(page, 'Revoke this token?')
        await expect(dialog).toContainText(name)
        await dialog.getByRole('button', { name: 'Revoke', exact: true }).click()
        const revokedStatus = (await revoked).status()
        r.note(`DELETE /connect/tokens/{id} -> ${revokedStatus}`)
        expect(revokedStatus).toBe(200)
        await expect(tokenRow(page, name)).toContainText('Revoked')
        await expect(tokenRow(page, name).getByRole('button', { name: 'Revoke' })).toHaveCount(0)

        if (!MOCK) expectRefused(await mcpToolsList(secret))
        r.note(MOCK ? 'dev mock: /mcp/global not served, MCP calls skipped' : 'tools/list: 200 while active, 401 after revoke')
      },
    })
    secret = ''
    expect(problems, `connect-mint-revoke: ${record.screenshot ?? ''}`).toEqual([])
  })

  test('a 1-day read token expires in a day and dies on revoke', async ({}, testInfo) => {
    const role: Role = roleOf(testInfo)
    const name = `${RUN_PREFIX}connect-1d-${role}`
    const before = Date.now()
    const minted = await apiCall(role, 'POST', '/connect/tokens', { name, scope: 'read', expires_in_days: 1 })
    const body = isRecord(minted.body) ? minted.body : {}
    const id = stringField(body, 'token_id')
    expect(minted.status).toBeLessThan(300)
    if (id === undefined) throw new Error('POST /connect/tokens answered no token_id')
    recordCreated('token', id, name, role)
    const secret = stringField(body, 'token') ?? ''
    const expires = Date.parse(stringField(body, 'expires_at') ?? '')
    expect(Math.abs(expires - (before + DAY_MS)), 'expires_at is one day out').toBeLessThan(EXPIRY_SLACK_MS)
    expect(stringField(body, 'scope')).toBe('read')

    if (!MOCK) expectWorks(await mcpToolsList(secret))
    const revoked = await apiCall(role, 'DELETE', `/connect/tokens/${encodeURIComponent(id)}`)
    expect(revoked.status).toBe(200)
    const token = isRecord(revoked.body) && isRecord(revoked.body['token']) ? revoked.body['token'] : undefined
    expect(stringField(token, 'status')).toBe('revoked')
    if (!MOCK) expectRefused(await mcpToolsList(secret))
  })
})
