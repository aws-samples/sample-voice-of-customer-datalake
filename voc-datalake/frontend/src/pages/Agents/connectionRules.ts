/**
 * @fileoverview The rules of a repository connection, as the server checks them (`PUT
 * /agents/engineering/connections/<id>`, the engineering connectors' `connections` module): its id, its host (GitHub
 * or GitLab), the repository (GitHub's `owner/name`, or a GitLab project's path, nested groups included), the default
 * branch, and the credential: a GitHub App's (its ids and its private key) or a GitLab project access token. The form
 * says what is wrong before anything is sent; the server checks again (a GitLab token against GitLab itself), and its
 * own reason is shown when it refuses.
 *
 * Editing a connection keeps its stored credential when the key or token is left empty, unless the host, the
 * repository or the App's ids change: those are stored with the credential, so it is needed again.
 *
 * @module pages/Agents/connectionRules
 */
import type { ConnectionHost, ConnectionRequest, EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** A connection id's longest. */
const MAX_CONNECTION_ID = 63
/** A default branch's longest. */
export const MAX_BRANCH = 255
/**
 * A private key's largest, in bytes: the server stores it with the rest in a standard parameter (4 KB), so a key
 * near that is refused there; an App's own 2048-bit key is about 1.7 KB.
 */
const MAX_PRIVATE_KEY_BYTES = 3800
/** A GitLab project path's longest, and the most segments it has (the project and up to 20 groups). */
const MAX_PROJECT_PATH = 255
const MAX_PROJECT_SEGMENTS = 21
/** The agents' own branches, which a default branch never is. */
const AGENT_BRANCH_PREFIX = 'voc-agent/'

const CONNECTION_ID = new RegExp(`^[a-z0-9][a-z0-9-]{0,${String(MAX_CONNECTION_ID - 1)}}$`)
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
const DIGITS = /^[1-9]\d{0,19}$/
const BRANCH = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,${String(MAX_BRANCH - 1)}}$`)
/** An unencrypted RSA private key in PEM: PKCS#1 (as GitHub hands it out) or PKCS#8. */
const PEM = /^-----BEGIN (RSA |)PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END \1PRIVATE KEY-----$/
/** One segment of a GitLab project's path (a group's or the project's own). */
const PROJECT_SEGMENT = /^\w[\w.-]*$/
/** A GitLab project access token, as GitLab shows it once when it is made. */
const GITLAB_TOKEN = /^glpat-[A-Za-z0-9_.-]{20,300}$/

export interface ConnectionForm {
  host: ConnectionHost
  connectionId: string
  repository: string
  defaultBranch: string
  appId: string
  installationId: string
  privateKey: string
  token: string
}

/** A new connection's form: GitHub, nothing typed, the branch `main`. */
export const EMPTY_CONNECTION_FORM: Readonly<ConnectionForm> = {
  host: 'github', connectionId: '', repository: '', defaultBranch: 'main', appId: '', installationId: '',
  privateKey: '', token: '',
}

/** The form's text fields (the host is a choice of its own). */
export type ConnectionField = Exclude<keyof ConnectionForm, 'host'>

/** What is wrong with a field, as its message key under `connections.invalid`. */
export type ConnectionIssue =
  | 'connectionId' | 'repository' | 'repositoryGitlab' | 'defaultBranch' | 'appId' | 'installationId'
  | 'privateKeyEmpty' | 'privateKeyNeeded' | 'privateKey' | 'privateKeyLarge'
  | 'tokenEmpty' | 'tokenNeeded' | 'token'
export type ConnectionIssues = Partial<Record<ConnectionField, ConnectionIssue>>

/** `owner/name` as GitHub names a repository. */
export function isRepository(text: string): boolean {
  const [owner = '', name = '', ...rest] = text.split('/')
  return rest.length === 0 && OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..'
}

/** A GitLab project's path as in its address: `group/project`, or nested groups (`group/subgroup/project`). */
export function isGitlabProject(text: string): boolean {
  const segments = text.split('/')
  if (text.length > MAX_PROJECT_PATH || segments.length < 2 || segments.length > MAX_PROJECT_SEGMENTS
    || text.includes('..')) return false
  return segments.every((part) => PROJECT_SEGMENT.test(part) && part !== '.' && part !== '..'
    && !part.endsWith('.git') && !part.endsWith('.atom'))
}

/** A GitLab project access token's shape (GitLab itself checks it on the save). */
export const isGitlabToken = (text: string): boolean => GITLAB_TOKEN.test(text)

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

/** Whether the save must carry the credential: always for a new connection, and when the host, the repository or the
 *  App's ids change (they are stored with the credential). */
function credentialNeeded(form: ConnectionForm, existing: EngineeringConnection | null): boolean {
  if (!existing?.credential.set || form.host !== existing.host || form.repository.trim() !== existing.repository) return true
  return form.host === 'github' && (form.appId.trim() !== (existing.credential.app_id ?? '')
    || form.installationId.trim() !== (existing.credential.installation_id ?? ''))
}

function appIssues(form: ConnectionForm, existing: EngineeringConnection | null, needed: boolean): ConnectionIssues {
  const issues: ConnectionIssues = {}
  const key = normalisedKey(form.privateKey)
  if (needed || key !== '') {
    if (!DIGITS.test(form.appId.trim())) issues.appId = 'appId'
    if (!DIGITS.test(form.installationId.trim())) issues.installationId = 'installationId'
  }
  const keyIssue = existing === null && key === '' ? 'privateKeyEmpty' : privateKeyIssue(key, needed)
  if (keyIssue !== undefined) issues.privateKey = keyIssue
  return issues
}

function tokenIssue(token: string, existing: EngineeringConnection | null, needed: boolean): ConnectionIssue | undefined {
  if (token === '') {
    if (existing === null) return 'tokenEmpty'
    return needed ? 'tokenNeeded' : undefined
  }
  return isGitlabToken(token) ? undefined : 'token'
}

/** What is wrong with the form, field by field (empty when it can be sent); only the chosen host's fields count. */
export function connectionIssues(form: ConnectionForm, existing: EngineeringConnection | null = null): ConnectionIssues {
  const gitlab = form.host === 'gitlab'
  const issues: ConnectionIssues = {}
  if (!CONNECTION_ID.test(form.connectionId.trim())) issues.connectionId = 'connectionId'
  const repository = form.repository.trim()
  if (gitlab ? !isGitlabProject(repository) : !isRepository(repository)) {
    issues.repository = gitlab ? 'repositoryGitlab' : 'repository'
  }
  if (!isBranchName(form.defaultBranch.trim())) issues.defaultBranch = 'defaultBranch'
  const needed = credentialNeeded(form, existing)
  if (!gitlab) return { ...issues, ...appIssues(form, existing, needed) }
  const token = tokenIssue(form.token.trim(), existing, needed)
  return token === undefined ? issues : { ...issues, token }
}

/** The request for a form with no issues: trimmed, with the credential only when a key or a token was entered. */
export function connectionRequest(form: ConnectionForm): ConnectionRequest {
  const fields = { repository: form.repository.trim(), default_branch: form.defaultBranch.trim() }
  if (form.host === 'gitlab') {
    const token = form.token.trim()
    return token === '' ? { host: 'gitlab', ...fields } : { host: 'gitlab', ...fields, credential: { token } }
  }
  const key = normalisedKey(form.privateKey)
  if (key === '') return { host: 'github', ...fields }
  return {
    host: 'github', ...fields,
    credential: { app_id: form.appId.trim(), installation_id: form.installationId.trim(), private_key: `${key}\n` },
  }
}

const DAY_MS = 86_400_000
/** A token this close to its expiry, or closer, is shown as expiring soon. */
export const EXPIRY_WARNING_DAYS = 30

/** How a GitLab token's expiry reads on `today` (`YYYY-MM-DD`): none known, fine, soon (within
 *  {@link EXPIRY_WARNING_DAYS}) or past (a token stops working on its expiry day). */
export type TokenExpiry = { state: 'none' } | { state: 'ok' | 'soon' | 'expired'; date: string }

export function tokenExpiry(expiresAt: string | null, today: string): TokenExpiry {
  if (expiresAt === null) return { state: 'none' }
  const until = Date.parse(`${expiresAt}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(until) || Number.isNaN(now)) return { state: 'none' }
  const days = Math.round((until - now) / DAY_MS)
  if (days <= 0) return { state: 'expired', date: expiresAt }
  return { state: days <= EXPIRY_WARNING_DAYS ? 'soon' : 'ok', date: expiresAt }
}

/** Today's calendar day in UTC, `YYYY-MM-DD`. */
export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10)
