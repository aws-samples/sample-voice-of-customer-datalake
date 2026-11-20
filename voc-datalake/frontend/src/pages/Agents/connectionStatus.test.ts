/**
 * @fileoverview Agents → Connections as a state (connectionStatus.ts, 7.52.00): every row of the "One primary per
 * state" table, in its order (the first that matches wins), an App's primary, how connections group under their Apps,
 * and the status line's facts.
 */
import { describe, it, expect } from 'vitest'
import { parseConnection } from '../../api/engineeringConnectionsApi'
import { appPrimary, connectionsSummary, groupConnections, rowPrimary } from './connectionStatus'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { GitHubApp, InstallationCheck } from '../../api/githubAppsApi'
import type { ConnectionIssues, IssuesSourceView } from '../../api/issuesSourceApi'

const TODAY = '2026-11-17'
const ATTESTED = { version: 1, state: 'attested', repository: 'example-org/web', points: [], by: 'admin', at: null, reason: null, cause: null }

function connection(fields: Record<string, unknown> = {}, credential: Record<string, unknown> = {}): EngineeringConnection {
  const parsed = parseConnection({
    connection_id: 'web', host: 'github', repository: 'example-org/web', default_branch: 'main', version: 1,
    credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31', expires_at: null, ...credential },
    ci_attestation: ATTESTED, ...fields,
  })
  if (parsed === null) throw new Error('fixture connection does not parse')
  return parsed
}

const app = (fields: Partial<GitHubApp> = {}): GitHubApp => ({
  app_id: '271828', slug: 'voc-agents-ac7a4f', owner: 'example-org', owner_type: 'Organization', html_url: '',
  webhook: true, connections: ['web'], created_at: null, created_by: null, version: 1, ...fields,
})

const issues = (fields: Partial<ConnectionIssues> = {}): ConnectionIssues => ({
  connection_id: 'web', repository: 'example-org/web', read: true, reading: true, reason: null, label: 'created', ...fields,
})

const check = (missing: string[]): InstallationCheck => ({ repositories: ['example-org/web'], missing, issues: null })

describe('a repository row\'s one primary', () => {
  it.each([
    ['a pasted key that is missing: Store the key', connection({}, { kind: 'app', set: false }), undefined, 'storeKey'],
    ['a GitLab token past its day: Replace token',
      connection({ host: 'gitlab' }, { kind: 'project_token', expires_at: '2026-11-01' }), undefined, 'replaceToken'],
    ['a GitLab token within 30 days: Replace token',
      connection({ host: 'gitlab' }, { kind: 'project_token', expires_at: '2026-11-30' }), undefined, 'replaceToken'],
    ['CI not attested: Attest CI', connection({ ci_attestation: null }), issues(), 'attest'],
    ['a withdrawn attestation: Attest CI', connection({ ci_attestation: { ...ATTESTED, state: 'withdrawn' } }), issues(), 'attest'],
    ['a label that could not be created: Create label', connection(), issues({ label: 'failed' }), 'createLabel'],
    ['all healthy: none', connection(), issues(), null],
  ] as const)('%s', (_name, row, said, expected) => {
    expect(rowPrimary(row, said, TODAY)).toBe(expected)
  })

  it('takes the first that matches, in the table\'s order', () => {
    const everything = connection({ ci_attestation: null }, { kind: 'app', set: false })
    expect([rowPrimary(everything, issues({ label: 'failed' }), TODAY),
      rowPrimary(connection({ ci_attestation: null }), issues({ label: 'failed' }), TODAY)]).toStrictEqual(['storeKey', 'attest'])
  })

  it('never asks an App\'s connection for a key of its own, nor a far-off GitLab token for a new one', () => {
    expect([rowPrimary(connection({}, { set: false }), issues(), TODAY),
      rowPrimary(connection({ host: 'gitlab' }, { kind: 'project_token', expires_at: '2027-06-01' }), undefined, TODAY)])
      .toStrictEqual([null, null])
  })

  it('offers Create label only on a connection whose issues follow the App', () => {
    expect(rowPrimary(connection({}, { kind: 'app' }), issues({ label: 'failed' }), TODAY)).toBeNull()
  })
})

describe('an App\'s one primary', () => {
  it.each([
    ['installed nowhere: Install on GitHub', app({ connections: [] }), undefined, 'install'],
    ['a check found repositories it no longer covers: Reinstall on GitHub', app(), check(['web']), 'reinstall'],
    ['checked and covered: none', app(), check([]), null],
    ['not checked in this session: none', app(), null, null],
  ] as const)('%s', (_name, given, found, expected) => {
    expect(appPrimary(given, found)).toBe(expected)
  })
})

describe('the groups', () => {
  it('puts each App\'s connections under it, and every other connection apart', () => {
    const viaApp = connection()
    const pasted = connection({ connection_id: 'pasted', repository: 'example-org/pasted' }, { kind: 'app' })
    const orphan = connection({ connection_id: 'orphan', repository: 'example-org/orphan' }, { app_id: '999' })
    const gitlab = connection({ connection_id: 'docs', host: 'gitlab' }, { kind: 'project_token', app_id: null })
    const groups = groupConnections([viaApp, pasted, orphan, gitlab], [app(), app({ app_id: '314159', slug: 'fresh', connections: [] })])
    expect([groups.apps.map((group) => [group.app.slug, group.connections.map((c) => c.connection_id)]),
      groups.others.map((c) => c.connection_id)]).toStrictEqual([[['voc-agents-ac7a4f', ['web']], ['fresh', []]], ['pasted', 'orphan', 'docs']])
  })

  it('keeps a public repository read only out of the Apps and the others, in its own group (7.57.00)', () => {
    const read = connection({ connection_id: 'tools', repository: 'other-org/tools', kind: 'public_read' }, { kind: 'public_read' })
    const groups = groupConnections([connection(), read], [app()])
    expect([groups.apps[0]?.connections.map((c) => c.connection_id), groups.others, groups.publicRead.map((c) => c.connection_id)])
      .toStrictEqual([['web'], [], ['tools']])
  })
})

describe('the status line', () => {
  const view = (entries: ConnectionIssues[]): IssuesSourceView => ({
    deployed: true, signs_in: 'app', app_id: '271828', repositories: [], managed: [], schedule: 'on', label: 'voc-agent',
    connections: entries,
  })
  const summary = (input: Partial<Parameters<typeof connectionsSummary>[0]>) => connectionsSummary({
    connections: [connection()], apps: [app()], issues: view([issues()]), checks: new Map(), today: TODAY, ...input,
  })

  it('says nothing is connected only with no App and no connection', () => {
    expect([summary({ connections: [], apps: [] }).empty, summary({ connections: [] }).empty]).toStrictEqual([true, false])
  })

  it('counts the repositories through each App, the other connections, and those whose CI waits', () => {
    const pasted = connection({ connection_id: 'pasted', ci_attestation: null }, { kind: 'app' })
    expect(summary({ connections: [connection(), pasted] })).toStrictEqual({
      empty: false, attention: true, through: [{ slug: 'voc-agents-ac7a4f', count: 1 }], others: 1, publicRead: 0, ciNeeded: 1,
      issuesRead: true,
    })
  })

  it('counts a public repository read only apart, with no CI to attest and nothing waiting on it (7.57.00)', () => {
    const read = connection({ connection_id: 'tools', repository: 'other-org/tools', kind: 'public_read', ci_attestation: null },
      { kind: 'public_read' })
    const counted = summary({ connections: [connection(), read] })
    expect([counted.publicRead, counted.ciNeeded, counted.attention, counted.others]).toStrictEqual([1, 0, false, 0])
    expect(rowPrimary(read, undefined, TODAY)).toBeNull()
  })

  it('needs attention when an App waits too, and says issues are read only while one is', () => {
    expect([summary({}).attention, summary({ apps: [app(), app({ app_id: '314159', slug: 'fresh', connections: [] })] }).attention,
      summary({ checks: new Map([['271828', check(['web'])]]) }).attention,
      summary({ issues: view([issues({ read: false, reading: false, reason: 'off' })]) }).issuesRead,
      summary({ issues: undefined }).issuesRead]).toStrictEqual([false, true, true, false, false])
  })
})
