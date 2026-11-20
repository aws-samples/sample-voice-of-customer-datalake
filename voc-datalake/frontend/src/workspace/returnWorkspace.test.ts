/**
 * GitHub's return to the App's pages outside a workspace goes straight back into the workspace the flow started in
 * (returnWorkspace.ts, gateDecision.ts), its query carried through, never through the workspace picker.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { withMemoryLocalStorage } from '@test/memoryLocalStorage'
import { gateDecision } from './gateDecision'
import { EXTERNAL_RETURN_PATHS, rememberReturnWorkspace, returnWorkspace } from './returnWorkspace'
import { rememberWorkspace } from './useMyWorkspaces'
import type { CurrentWorkspace } from './currentWorkspace'

const ws = (slug: string): CurrentWorkspace => ({ id: `ws_${slug}`, slug, name: slug, role: 'admin' })
const MINE = [ws('acme'), ws('aws'), ws('beta')]
const INSTALLED = '/agents/connections/github/installed'
const NOW = 1_800_000_000_000

const local = withMemoryLocalStorage()

afterEach(() => {
  window.sessionStorage.clear()
})

describe('returnWorkspace', () => {
  it('is the workspace the flow started in, for an hour', () => {
    rememberReturnWorkspace('aws', NOW)
    expect(EXTERNAL_RETURN_PATHS.map((path) => returnWorkspace(path, MINE, NOW + 1000))).toStrictEqual(['aws', 'aws'])
    expect(returnWorkspace(INSTALLED, MINE, NOW + 61 * 60 * 1000)).toBe('acme')
  })

  it('falls back to the workspace last entered, then the first, and only among the caller\'s', () => {
    rememberWorkspace('beta')
    expect(returnWorkspace(INSTALLED, MINE, NOW)).toBe('beta')
    rememberReturnWorkspace('Not a slug', NOW)
    expect(returnWorkspace(INSTALLED, MINE, NOW)).toBe('beta')
    rememberWorkspace('gone')
    window.sessionStorage.clear()
    expect(returnWorkspace(INSTALLED, MINE, NOW)).toBe('acme')
    local.clear()
    expect([returnWorkspace(INSTALLED, MINE, NOW), returnWorkspace(INSTALLED, [], NOW)]).toStrictEqual(['acme', null])
  })

  it('goes back to the flow\'s workspace even when the caller\'s list does not name it (a platform admin\'s entry)', () => {
    rememberReturnWorkspace('field-team', NOW)
    expect(returnWorkspace(INSTALLED, MINE, NOW)).toBe('field-team')
  })

  it('is no page\'s but the two GitHub returns\'', () => {
    rememberReturnWorkspace('aws', NOW)
    expect(['/agents/connections', '/dashboard'].map((path) => returnWorkspace(path, MINE, NOW))).toStrictEqual([null, null])
  })
})

describe('the gate on a GitHub return outside a workspace', () => {
  it('redirects into the flow\'s workspace with the query, in place of the address, instead of the picker', () => {
    const path = `${INSTALLED}?installation_id=7&setup_action=install&state=s`
    expect(gateDecision({ kind: 'none' }, MINE, path, null, 'aws'))
      .toStrictEqual({ kind: 'redirect', to: `/workspace/aws${path}`, replace: true })
    expect(gateDecision({ kind: 'none' }, MINE, path).kind).toBe('pick')
  })
})
