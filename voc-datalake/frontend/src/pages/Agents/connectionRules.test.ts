/**
 * @fileoverview A repository connection's rules, as the server checks them: its id, `owner/name`, a default branch
 * git takes (never an agent's), the GitHub App's ids and its unencrypted RSA private key in PEM; when an edit may
 * keep the stored credential; and the request a valid form sends.
 */
import { describe, it, expect } from 'vitest'
import { EMPTY_CONNECTION_FORM, connectionIssues, connectionRequest, isBranchName, isRepository } from './connectionRules'
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
  credential: { kind: 'app', set: true, app_id: '123', installation_id: '456' },
  created_at: null, created_by: null, updated_at: null, updated_by: null,
}

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
