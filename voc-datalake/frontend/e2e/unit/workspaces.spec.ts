/**
 * The workspace helpers of tests/workspace-lifecycle.spec.ts and the shared teardown (lib/workspaces.ts), offline:
 * the run's slug and the lenient reads of the workspace routes' answers. The ledger's `workspace` field is checked
 * with the other ledger kinds in helpers.spec.ts (one file writes the unit run's created.json at a time).
 */
import { expect, test } from '@playwright/test'
import { WORKSPACE_SLUG, answeredWorkspace, errorText, listedWorkspaces, slugFor, workspacePlugins } from '../lib/workspaces'

test('a run\'s workspace slug: e2e-<run id>, lowercase, at most 40 characters, a valid slug', () => {
  expect(slugFor('1763200000000')).toBe('e2e-1763200000000')
  expect(slugFor('s1-1763200000000')).toBe('e2e-s1-1763200000000')
  expect(slugFor('Run_ID.7')).toBe('e2e-run-id-7')
  const long = slugFor(`${'a'.repeat(35)}-${'b'.repeat(20)}`)
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long).toMatch(WORKSPACE_SLUG)
  // Cut at a hyphen: the trailing one goes (a slug cannot end with "-").
  expect(slugFor(`${'a'.repeat(35)}-x`)).toBe(`e2e-${'a'.repeat(35)}`)
  for (const id of ['1763200000000', 's1-1763200000000', 'unit-1']) expect(slugFor(id)).toMatch(WORKSPACE_SLUG)
})

test('the workspace routes\' answers are read leniently', () => {
  expect(answeredWorkspace({ workspace: { id: 'ws_1', name: 'e2e-x', slug: 'e2e-x', role: 'admin', platform_admin: true } }))
    .toStrictEqual({ id: 'ws_1', name: 'e2e-x', slug: 'e2e-x', role: 'admin' })
  expect(answeredWorkspace({ workspace: { id: 'ws_1', slug: 'e2e-x' } })).toBeNull()
  expect(answeredWorkspace({ success: false, error: 'Workspace not found' })).toBeNull()
  expect(listedWorkspaces({ workspaces: [{ id: 'ws_1', name: 'A', slug: 'a-1', status: 'deleting' }, { id: 7 }, 'x'] }))
    .toStrictEqual([{ id: 'ws_1', name: 'A', slug: 'a-1', status: 'deleting' }])
  expect(listedWorkspaces(null)).toStrictEqual([])
  expect(workspacePlugins({ plugins: [{ id: 'web_reviews', enabled: true }, { id: 'webscraper' }, { enabled: true }] }))
    .toStrictEqual([{ id: 'web_reviews', enabled: true }, { id: 'webscraper', enabled: false }])
  expect(errorText({ success: false, error: 'Enable this plugin for the workspace first' })).toBe('Enable this plugin for the workspace first')
  expect(errorText('<html>')).toBe('')
})
