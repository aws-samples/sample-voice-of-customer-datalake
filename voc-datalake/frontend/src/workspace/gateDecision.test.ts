/**
 * The workspace gate's decision table (docs/multi-workspace.md, Request flow step 1).
 */
import { describe, expect, it } from 'vitest'
import { gateDecision } from './gateDecision'
import { ACME, JUNIPER } from '../test/workspaceFixtures'
const NONE = { kind: 'none' } as const

describe('gateDecision with a slug in the address', () => {
  it('enters the workspace the slug names', () => {
    expect(gateDecision({ kind: 'slug', slug: 'juniper' }, [ACME, JUNIPER], '/dashboard')).toStrictEqual({ kind: 'enter', workspace: JUNIPER })
  })

  it('answers not-found, with the caller\'s own, for a slug that is not theirs or cannot exist', () => {
    expect(gateDecision({ kind: 'slug', slug: 'globex' }, [ACME], '/')).toStrictEqual({ kind: 'not-found', workspaces: [ACME] })
    expect(gateDecision({ kind: 'invalid' }, [], '/')).toStrictEqual({ kind: 'not-found', workspaces: [] })
  })
})

describe('gateDecision without a slug', () => {
  it('moves a caller with one workspace into it, keeping the path, query and hash', () => {
    expect(gateDecision(NONE, [ACME], '/projects/p1?tab=docs#top')).toStrictEqual({ kind: 'redirect', to: '/w/acme/projects/p1?tab=docs#top' })
    expect(gateDecision(NONE, [ACME], '/')).toStrictEqual({ kind: 'redirect', to: '/w/acme/' })
  })

  it('offers the picker for two or more, never choosing one itself, keeping the path asked for', () => {
    expect(gateDecision(NONE, [ACME, JUNIPER], '/')).toStrictEqual({ kind: 'pick', workspaces: [ACME, JUNIPER], path: '/' })
    expect(gateDecision(NONE, [ACME, JUNIPER], '/dashboard')).toStrictEqual({ kind: 'pick', workspaces: [ACME, JUNIPER], path: '/dashboard' })
  })

  it('opens the app as before workspaces for none', () => {
    expect(gateDecision(NONE, [], '/dashboard')).toStrictEqual({ kind: 'without-workspace' })
  })
})

describe('gateDecision when the list could not be read', () => {
  it('opens the app as before workspaces for an address without a slug', () => {
    expect(gateDecision(NONE, null, '/')).toStrictEqual({ kind: 'without-workspace' })
  })

  it.each([{ kind: 'slug', slug: 'acme' } as const, { kind: 'invalid' } as const])(
    'never opens a workspace address without its workspace (%j): it says the list is unavailable',
    (path) => {
      expect(gateDecision(path, null, '/')).toStrictEqual({ kind: 'unavailable' })
    },
  )
})
