/**
 * The Agents pages' addresses (agentsPaths.ts): the list's views and the Skills role and version are paths, an
 * agent's tab is `/agents/<id>/<tab>`, and the query names no view (no old `?tab=` link is redirected). The view names
 * are never an agent's id (`ag_<hex>`), nor is `workspace` (the workspace prefix).
 */
import { describe, expect, it } from 'vitest'
import { readTabAddress } from '../../utils/tabPaths'
import { AGENTS_VIEWS, agentIdOf, agentPath, agentTabPage, agentsPath, readAgentsAddress } from './agentsPaths'
import { engineeringRunPagePath, flowRunsPath, workflowPath } from './workflowPaths'

const read = (pathname: string, search = '') => readAgentsAddress({ pathname, search })

describe('the list\'s views', () => {
  it.each([
    ['/agents', { view: 'agents', role: null, version: null }],
    ['/agents/workflows', { view: 'workflows', role: null, version: null }],
    ['/agents/spend', { view: 'spend', role: null, version: null }],
    ['/agents/connections', { view: 'connections', role: null, version: null }],
    ['/agents/skills', { view: 'skills', role: null, version: null }],
    ['/agents/skills/fixer', { view: 'skills', role: 'fixer', version: null }],
    ['/agents/skills/fixer/versions/3', { view: 'skills', role: 'fixer', version: 3 }],
  ])('%s is %o, as it is', (pathname, place) => {
    expect(read(pathname, '?month=2026-11')).toStrictEqual({ place, replaceWith: null })
  })

  it.each([
    ['/agents/skills/fixer/versions/x', '', '/agents/skills/fixer', ''],
    ['/agents/spend/extra', '?by=day', '/agents/spend', '?by=day'],
  ])('replaces %s%s by %s%s', (pathname, search, to, kept) => {
    expect(read(pathname, search)?.replaceWith).toStrictEqual({ pathname: to, search: kept })
  })

  it('are Agent orchestration\'s tabs, in their order (7.52.00: operate, build, then the set-up-once plumbing)', () => {
    expect(AGENTS_VIEWS).toStrictEqual(['agents', 'runs', 'skills', 'spend', 'workflows', 'registry', 'connections'])
  })

  it('leaves every place under the Registry to its page (7.52.00 C3), never replacing it', () => {
    expect([read('/agents/registry'), read('/agents/registry/gates'), read('/agents/registry/cards/fixer-careful/v/2')])
      .toStrictEqual(Array.from({ length: 3 }, () => ({ place: { view: 'registry', role: null, version: null }, replaceWith: null })))
    expect(agentsPath({ view: 'registry' })).toBe('/agents/registry')
  })

  it('reads no view from the query (no old `?tab=` link is redirected)', () => {
    expect(read('/agents', '?tab=spend')).toStrictEqual({ place: { view: 'agents', role: null, version: null }, replaceWith: null })
    expect(AGENTS_VIEWS.some((view: string) => view === 'workspace')).toBe(false)
  })

  it('is not the address of an agent, a workflow, a run or the GitHub return pages', () => {
    expect(['/agents/ag_0123456789ab', '/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3'].map((pathname) => read(pathname)))
      .toStrictEqual([null, null])
    expect(AGENTS_VIEWS.some((view) => /^ag_[0-9a-f]{12}$/.test(view))).toBe(false)
  })

  it('builds the links', () => {
    expect([agentsPath({ view: 'agents' }), agentsPath({ view: 'skills', role: 'fixer', version: 2 }), agentsPath({ view: 'spend', role: 'x' })])
      .toStrictEqual(['/agents', '/agents/skills/fixer/versions/2', '/agents/spend'])
    expect([flowRunsPath('wf_1'), workflowPath('wf_1'), engineeringRunPagePath('r1')])
      .toStrictEqual(['/agents/runs?flow=wf_1', '/agents/workflows/wf_1', '/agents/engineering/r1'])
  })
})

describe('an agent\'s tabs', () => {
  const page = agentTabPage('ag_1', ['settings', 'triggers', 'runs'] as const)

  it.each([
    ['/agents/ag_1', '', 'settings', null],
    ['/agents/ag_1/runs', '', 'runs', null],
    ['/agents/ag_1', '?tab=runs&review=fb_1', 'settings', null],
    ['/agents/ag_1/nope', '', 'settings', { pathname: '/agents/ag_1/settings', search: '' }],
  ])('%s%s opens %s, replaced by %o', (pathname, search, tab, replaceWith) => {
    expect(readTabAddress(page, { pathname, search })).toStrictEqual({ place: tab, replaceWith })
  })

  it('links a tab, and reads the agent from any of its pages', () => {
    expect([agentPath('ag_1'), agentPath('ag_1', 'runs')]).toStrictEqual(['/agents/ag_1', '/agents/ag_1/runs'])
    expect([agentIdOf('/agents/ag_1/runs'), agentIdOf('/agents/spend'), agentIdOf('/dashboard')]).toStrictEqual(['ag_1', null, null])
  })
})
