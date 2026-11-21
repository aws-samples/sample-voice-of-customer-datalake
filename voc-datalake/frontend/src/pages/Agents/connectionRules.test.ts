/**
 * @fileoverview A repository connection's rules, as the server checks them: its id, `owner/name`, a default branch
 * git takes (never an agent's), the GitHub App's ids and its unencrypted RSA private key in PEM; when an edit may
 * keep the stored credential; and the request a valid form sends. For GitLab: a project's path with nested groups,
 * a project access token's shape, when an edit keeps the stored token, and how its expiry reads.
 */
import { describe, it, expect } from 'vitest'
import {
  EMPTY_CONNECTION_FORM, connectionIssues, connectionRequest, isBranchName, isGitlabProject, isGitlabToken, isRepository,
  todayUtc, tokenExpiry,
} from './connectionRules'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { ConnectionForm } from './connectionRules'

// An obviously fake key, built at runtime so nothing reads it as a real one: the PEM shape around base64 filler.
const pem = (lines = 2, label = 'RSA PRIVATE KEY') =>
  [`-----BEGIN ${label}-----`, ...Array.from({ length: lines }, () => 'A'.repeat(64)), `-----END ${label}-----`].join('\n')
const form = (fields: Partial<ConnectionForm>): ConnectionForm => ({
  ...EMPTY_CONNECTION_FORM, connectionId: 'web-app', repository: 'example-org/web-app', appId: '123',
  installationId: '456', privateKey: pem(), ...fields,
})
const stored: EngineeringConnection = {
  connection_id: 'web-app', host: 'github', repository: 'example-org/web-app', default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: '123', installation_id: '456', expires_at: null,
    expires_in_days: null, login: null, saved_by_you: false, owner: null },
  created_at: null, created_by: null, updated_at: null, updated_by: null, version: 1, ci_attestation: null,
  repository_private: null, kind: 'repository', public: null, fork: null,
}
// A fake GitLab project access token: its shape only.
const TOKEN = `glpat-${'x'.repeat(20)}`
const gitlabForm = (fields: Partial<ConnectionForm>): ConnectionForm => ({
  ...EMPTY_CONNECTION_FORM, host: 'gitlab', connectionId: 'docs', repository: 'example-group/web/docs', token: TOKEN, ...fields,
})
const storedGitlab: EngineeringConnection = {
  ...stored, connection_id: 'docs', host: 'gitlab', repository: 'example-group/web/docs',
  credential: { kind: 'project_token', set: true, app_id: null, installation_id: null, expires_at: '2027-01-31',
    expires_in_days: null, login: null, saved_by_you: false, owner: null },
}

describe('a GitLab connection\'s rules', () => {
  it('takes a project\'s path with its groups, nested ones included', () => {
    expect(['group/project', 'a/b/c', 'g_1/sub.x/p-y', `${Array.from({ length: 20 }, () => 'g').join('/')}/p`]
      .map(isGitlabProject)).toStrictEqual([true, true, true, true])
    expect(['project', 'g//p', 'g/.', 'g/..', 'g/p.git', 'g/p.atom', '-g/p', 'g/sp ace', 'g/a..b',
      `${Array.from({ length: 21 }, () => 'g').join('/')}/p`, `g/${'p'.repeat(254)}`]
      .map(isGitlabProject)).toStrictEqual(Array.from({ length: 11 }, () => false))
  })

  it('takes only a project access token\'s shape', () => {
    expect([TOKEN, `glpat-${'A1_.-'.repeat(60)}`].map(isGitlabToken)).toStrictEqual([true, true])
    expect(['', 'glpat-short', `ghp_${'x'.repeat(30)}`, `glpat-${'x'.repeat(301)}`, `glpat-${'x'.repeat(19)} `]
      .map(isGitlabToken)).toStrictEqual([false, false, false, false, false])
  })

  it('checks only the GitLab fields, and needs the token to add one', () => {
    expect(connectionIssues(gitlabForm({ appId: 'not digits', privateKey: '' }))).toStrictEqual({})
    expect(connectionIssues(gitlabForm({ repository: 'example-org', token: '' })))
      .toStrictEqual({ repository: 'repositoryGitlab', token: 'tokenEmpty' })
    expect(connectionIssues(gitlabForm({ token: 'glpat-nope' }))).toStrictEqual({ token: 'token' })
  })

  it('keeps the stored token on an edit with none, unless the host or the project changes', () => {
    expect(connectionIssues(gitlabForm({ token: '', defaultBranch: 'trunk' }), storedGitlab)).toStrictEqual({})
    expect(connectionIssues(gitlabForm({ token: '', repository: 'example-group/other' }), storedGitlab))
      .toStrictEqual({ token: 'tokenNeeded' })
    expect(connectionIssues(gitlabForm({ token: '', repository: 'example-org/web-app' }), stored)).toStrictEqual({ token: 'tokenNeeded' })
  })

  it('sends the token only when one was typed, trimmed', () => {
    expect(connectionRequest(gitlabForm({ token: '' }))).toStrictEqual({
      host: 'gitlab', repository: 'example-group/web/docs', default_branch: 'main',
    })
    expect(connectionRequest(gitlabForm({ token: ` ${TOKEN} ` }))).toStrictEqual({
      host: 'gitlab', repository: 'example-group/web/docs', default_branch: 'main', credential: { token: TOKEN },
    })
  })
})

describe('a GitLab token\'s expiry', () => {
  it('reads fine, soon within 30 days, and expired on its day', () => {
    expect(tokenExpiry('2027-03-01', '2027-01-01')).toStrictEqual({ state: 'ok', date: '2027-03-01' })
    expect([tokenExpiry('2027-01-31', '2027-01-01').state, tokenExpiry('2027-02-01', '2027-01-01').state])
      .toStrictEqual(['soon', 'ok'])
    expect([tokenExpiry('2027-01-01', '2027-01-01').state, tokenExpiry('2026-12-01', '2027-01-01').state])
      .toStrictEqual(['expired', 'expired'])
  })

  it('reads none for no expiry, or one that is not a day', () => {
    expect([tokenExpiry(null, '2027-01-01'), tokenExpiry('soon', '2027-01-01')]).toStrictEqual([{ state: 'none' }, { state: 'none' }])
    expect(todayUtc(new Date('2027-01-02T23:30:00Z'))).toBe('2027-01-02')
  })
})

describe('the connection rules', () => {
  it('takes owner/name as GitHub names a repository', () => {
    expect(['example-org/web-app', 'a/b.c_d-e', `${'o'.repeat(39)}/${'n'.repeat(100)}`].map(isRepository)).toStrictEqual([true, true, true])
    expect(['example-org', '-org/x', 'org/.', 'org/..', 'a/b/c', `${'o'.repeat(40)}/x`, `o/${'n'.repeat(101)}`, 'org/sp ace']
      .map(isRepository)).toStrictEqual([false, false, false, false, false, false, false, false])
  })

  it('takes a default branch git takes, of at most 255 characters, that is not an agent\'s branch', () => {
    expect(['main', 'release/2026.11', 'trunk_v2', 'x'.repeat(255)].map(isBranchName)).toStrictEqual([true, true, true, true])
    expect(['', 'a b', 'a..b', '-x', 'x/', 'x.', 'x.lock', 'a~b', 'a//b', 'a/.b', 'a@{b', 'ünï', 'voc-agent/fix-1', 'x'.repeat(256)]
      .map(isBranchName)).toStrictEqual(Array.from({ length: 14 }, () => false))
  })

  it('needs the whole credential to add a connection', () => {
    expect(connectionIssues(form({}))).toStrictEqual({})
    expect(connectionIssues(form({ privateKey: pem(2, 'PRIVATE KEY') }))).toStrictEqual({})
    expect(connectionIssues(form({ connectionId: '-web', privateKey: '' }))).toStrictEqual({ connectionId: 'connectionId', privateKey: 'privateKeyEmpty' })
  })

  it('takes only an App\'s numbers and an unencrypted RSA key the server can store', () => {
    expect(connectionIssues(form({ appId: '12a', installationId: '0', privateKey: 'key' })))
      .toStrictEqual({ appId: 'appId', installationId: 'installationId', privateKey: 'privateKey' })
    expect(connectionIssues(form({ privateKey: pem(2, 'ENCRYPTED PRIVATE KEY') }))).toStrictEqual({ privateKey: 'privateKey' })
    expect(connectionIssues(form({ privateKey: pem(60) }))).toStrictEqual({ privateKey: 'privateKeyLarge' })
  })

  it('keeps the stored credential on an edit with no key, unless the repository or the App changes', () => {
    expect(connectionIssues(form({ privateKey: '', defaultBranch: 'trunk' }), stored)).toStrictEqual({})
    expect(connectionIssues(form({ privateKey: '', repository: 'example-org/other' }), stored)).toStrictEqual({ privateKey: 'privateKeyNeeded' })
    expect(connectionIssues(form({ privateKey: '', installationId: '789' }), stored)).toStrictEqual({ privateKey: 'privateKeyNeeded' })
    expect(connectionIssues(form({ privateKey: '' }), { ...stored, credential: { ...stored.credential, set: false } }))
      .toStrictEqual({ privateKey: 'privateKeyNeeded' })
  })

  it('sends the credential only with a key, trimmed, its line ends made \\n', () => {
    expect(connectionRequest(form({ privateKey: '', repository: ' example-org/web-app ' }))).toStrictEqual({
      host: 'github', repository: 'example-org/web-app', default_branch: 'main',
    })
    expect(connectionRequest(form({ appId: ' 1 ', installationId: '2', privateKey: `\n${pem().replaceAll('\n', '\r\n')}\r\n` }))).toStrictEqual({
      host: 'github', repository: 'example-org/web-app', default_branch: 'main',
      credential: { app_id: '1', installation_id: '2', private_key: `${pem()}\n` },
    })
  })
})
