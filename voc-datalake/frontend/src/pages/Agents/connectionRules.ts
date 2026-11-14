/**
 * @fileoverview The rules of a repository connection, as the server checks them (`PUT
 * /agents/engineering/connections/<id>`, the engineering connectors' `connections` module): its id, the repository
 * (`owner/name`), the default branch, and the GitHub App's credential (its ids and its private key). The form says
 * what is wrong before anything is sent; the server checks again, and its own reason is shown when it refuses.
 *
 * Editing a connection keeps its stored credential when the private key is left empty, unless the repository or the
 * App's ids change: those are stored with the key, so the key is needed again.
 *
 * @module pages/Agents/connectionRules
 */
import type { ConnectionRequest, EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** A connection id's longest. */
const MAX_CONNECTION_ID = 63
/** A default branch's longest. */
export const MAX_BRANCH = 255
/**
 * A private key's largest, in bytes: the server stores it with the rest in a standard parameter (4 KB), so a key
 * near that is refused there; an App's own 2048-bit key is about 1.7 KB.
 */
const MAX_PRIVATE_KEY_BYTES = 3800
/** The agents' own branches, which a default branch never is. */
const AGENT_BRANCH_PREFIX = 'voc-agent/'

const CONNECTION_ID = new RegExp(`^[a-z0-9][a-z0-9-]{0,${String(MAX_CONNECTION_ID - 1)}}$`)
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
const DIGITS = /^[1-9]\d{0,19}$/
const BRANCH = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,${String(MAX_BRANCH - 1)}}$`)
/** An unencrypted RSA private key in PEM: PKCS#1 (as GitHub hands it out) or PKCS#8. */
const PEM = /^-----BEGIN (RSA |)PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END \1PRIVATE KEY-----$/

export interface ConnectionForm {
  connectionId: string
  repository: string
  defaultBranch: string
  appId: string
  installationId: string
  privateKey: string
}

/** A new connection's form: nothing typed, the branch `main`. */
export const EMPTY_CONNECTION_FORM: Readonly<ConnectionForm> = {
  connectionId: '', repository: '', defaultBranch: 'main', appId: '', installationId: '', privateKey: '',
}

export type ConnectionField = keyof ConnectionForm

/** What is wrong with a field, as its message key under `connections.invalid`. */
type ConnectionIssue =
  | 'connectionId' | 'repository' | 'defaultBranch' | 'appId' | 'installationId'
  | 'privateKeyEmpty' | 'privateKeyNeeded' | 'privateKey' | 'privateKeyLarge'
export type ConnectionIssues = Partial<Record<ConnectionField, ConnectionIssue>>

/** `owner/name` as GitHub names a repository. */
export function isRepository(text: string): boolean {
  const [owner = '', name = '', ...rest] = text.split('/')
  return rest.length === 0 && OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..'
}

/** A default branch the server takes: git's rules on an ASCII name of at most {@link MAX_BRANCH}, not an agent's. */
export function isBranchName(text: string): boolean {
  if (!BRANCH.test(text) || text.includes('..') || text.includes('@{') || /[/.]$/.test(text)) return false
  if (text.startsWith(AGENT_BRANCH_PREFIX)) return false
  return text.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** The key as it is sent: its line ends made `\n`, trimmed. */
const normalisedKey = (key: string): string => key.replaceAll('\r\n', '\n').trim()

function privateKeyIssue(key: string, needed: boolean): ConnectionIssue | undefined {
  if (key === '') return needed ? 'privateKeyNeeded' : undefined
  if (new TextEncoder().encode(key).length > MAX_PRIVATE_KEY_BYTES) return 'privateKeyLarge'
  return PEM.test(key) ? undefined : 'privateKey'
}

/** Whether the save must carry the credential: always for a new connection, and when the repository or the App's ids
 *  change (they are stored with the key). */
function credentialNeeded(form: ConnectionForm, existing: EngineeringConnection | null): boolean {
  if (!existing?.credential.set) return true
  return form.repository.trim() !== existing.repository || form.appId.trim() !== (existing.credential.app_id ?? '')
    || form.installationId.trim() !== (existing.credential.installation_id ?? '')
}

/** What is wrong with the form, field by field (empty when it can be sent). */
export function connectionIssues(form: ConnectionForm, existing: EngineeringConnection | null = null): ConnectionIssues {
  const issues: ConnectionIssues = {}
  if (!CONNECTION_ID.test(form.connectionId.trim())) issues.connectionId = 'connectionId'
  if (!isRepository(form.repository.trim())) issues.repository = 'repository'
  if (!isBranchName(form.defaultBranch.trim())) issues.defaultBranch = 'defaultBranch'
  const key = normalisedKey(form.privateKey)
  const needed = credentialNeeded(form, existing)
  if (needed || key !== '') {
    if (!DIGITS.test(form.appId.trim())) issues.appId = 'appId'
    if (!DIGITS.test(form.installationId.trim())) issues.installationId = 'installationId'
  }
  const keyIssue = existing === null && key === '' ? 'privateKeyEmpty' : privateKeyIssue(key, needed)
  if (keyIssue !== undefined) issues.privateKey = keyIssue
  return issues
}

/** The request for a form with no issues: trimmed, with the credential only when a private key was entered. */
export function connectionRequest(form: ConnectionForm): ConnectionRequest {
  const request: ConnectionRequest = {
    host: 'github', repository: form.repository.trim(), default_branch: form.defaultBranch.trim(),
  }
  const key = normalisedKey(form.privateKey)
  if (key === '') return request
  return {
    ...request,
    credential: { app_id: form.appId.trim(), installation_id: form.installationId.trim(), private_key: `${key}\n` },
  }
}
