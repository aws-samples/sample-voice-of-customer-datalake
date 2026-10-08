/**
 * F1 (E2E-COVERAGE-GAPS.md §3): the per-project Export / MCP tab is removed; the
 * global MCP on /connect replaces it. Both roles.
 *
 * - Given a project the caller can view, When `/projects/:id` loads, Then there
 *   is no MCP / Export tab; `?tab=mcp` falls back to Overview with the URL
 *   rewritten and no page error.
 * - When the header's "Connect via MCP" is followed, Then Connect opens with the
 *   project pre-selected and `connect-endpoint` shows `/mcp/global`.
 * - 3.00.00 RETIRED the per-project backend (CHANGELOG Upgrade notes): its token
 *   routes and `GET /projects/{id}/autoseed` answer 404 even for the admin who
 *   manages the project. With a well-shaped (unknown) bearer, the retired
 *   `POST /mcp` is unwired (API Gateway's 403 "Missing Authentication Token")
 *   while `POST /mcp/global` reaches its handler and answers 401.
 *
 * Data: one public `e2e-<run id>-mcp-removed` project made through the admin API
 * and recorded in the ledger, so cleanup deletes it.
 */
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { RUN_PREFIX, apiUrl } from '../lib/env'
import { assertStep, roleOf, settle, site } from '../lib/fixtures'
import { ensureE2eProject, projectIdOrSkip } from '../lib/projects'

const PROJECT = `${RUN_PREFIX}mcp-removed`



test.describe('projects: per-project Export / MCP removed', () => {
  test.beforeAll(async () => {
    // Public, so the user role sees the same page the admin does.
    await ensureE2eProject(PROJECT, 'public')
  })

  test('no MCP / Export tab; ?tab=mcp lands on Overview with the URL rewritten', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const id = projectIdOrSkip(PROJECT)
    await assertStep(page, role, 'projects-mcp-removed-tabs', async (r) => {
      await page.goto(site(`/projects/${id}?tab=mcp`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const tabs = page.getByRole('tab')
      await expect(tabs).toHaveCount(4)
      await expect(page.getByRole('tab', { name: /MCP|Export/ })).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
      await expect(page).not.toHaveURL(/[?&]tab=mcp/)
      await expect(page.getByText(/mcp\.json/i)).toHaveCount(0)
      r.note(`tabs: ${(await tabs.allTextContents()).join(' | ')}; url ${page.url()}`)
    })
  })

  test('the header link opens the global Connect page, pinned to the project', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const id = projectIdOrSkip(PROJECT)
    await assertStep(page, role, 'projects-mcp-removed-connect-link', async (r) => {
      await page.goto(site(`/projects/${id}`), { waitUntil: 'domcontentloaded' })
      await page.getByRole('link', { name: 'Connect via MCP' }).click()
      await expect(page).toHaveURL(new RegExp(`/connect\\?project=${encodeURIComponent(id)}$`))
      await expect(page.getByTestId('connect-endpoint')).toContainText('/mcp/global')
      r.note(`connect opened at ${page.url()}`)
    })
  })

  test('the retired per-project token and autoseed routes are gone (admin)', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'checked as the project owner, who could use them before')
    const id = encodeURIComponent(projectIdOrSkip(PROJECT))
    for (const [method, path] of [
      ['GET', `/projects/${id}/api-tokens`],
      ['POST', `/projects/${id}/api-tokens`],
      ['DELETE', `/projects/${id}/api-tokens/tok_0123456789abcdef`],
      ['GET', `/projects/${id}/autoseed`],
    ] as const) {
      const res = await apiCall('admin', method, path, method === 'POST' ? { name: 'e2e', scopes: ['feedback:read'] } : undefined)
      expect(res.status, `${method} ${path} was retired in 3.00.00`).toBe(404)
    }
  })

  test('POST /mcp is unwired; POST /mcp/global still answers', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'role-independent; run once')
    // Shape-valid for the gateway's token authorizer, unknown to the server: no secret.
    const bearer = `Bearer voc_tok_0123456789abcdef_${'0'.repeat(64)}`
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const post = (path: string) => fetch(`${apiUrl()}${path}`, {
      method: 'POST', headers: { Authorization: bearer, 'Content-Type': 'application/json' }, body: ping,
    })
    expect((await post('/mcp')).status, 'POST /mcp was retired in 3.00.00').toBe(403)
    expect((await post('/mcp/global')).status, 'an unknown token is a 401 at the global server').toBe(401)
  })
})
