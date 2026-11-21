/**
 * @fileoverview The rules of a repository connected with a fine-grained token (7.60.00), as the server checks them
 * (`lambda/engineering/connectors/fine_grained.py`), pure: the token's shape (a fine-grained personal access token,
 * `github_pat_…`; a classic token, an OAuth or an App's token is refused by its prefix), the repository's
 * (`owner/name`, or its github.com address), GitHub's page that makes the token, prefilled, and how a token's expiry
 * reads (expired, within the 14-day warning, fine).
 *
 * GitHub's new-token page takes, as its documentation says ("Pre-filling fine-grained personal access token details
 * using URL parameters", read 2026-11-20): `name` (at most 40 characters), `description`, `target_name` (the resource
 * owner), `expires_in` (days) and one parameter per permission (`contents=write`, `pull_requests=write`). The
 * repository selection ("Only select repositories" → the repository) cannot be prefilled: the person picks it there.
 *
 * @module pages/Agents/tokenConnectionRules
 */
import { isRepository } from './connectionRules'

/** GitHub's page that makes a fine-grained personal access token. */
export const NEW_TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'
/** The longest a token may live (the server refuses a later expiry). */
export const MAX_TOKEN_DAYS = 90
/** A token this close to its expiry, or closer, is shown as expiring soon (GitLab's tokens keep their 30). */
export const TOKEN_WARNING_DAYS = 14
/** The longest name GitHub's prefill takes. */
const MAX_TOKEN_NAME = 40
const FINE_GRAINED_TOKEN = /^github_pat_\w{20,255}$/
/** A classic token's, an OAuth token's, a user-to-server token's, an App installation's or a refresh token's prefix. */
const OTHER_TOKEN = /^gh[pousr]_/
const GITHUB_ADDRESS = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/

/** What is wrong with a pasted token, by its message key under `connections.token.invalid`. */
export type TokenIssue = 'tokenEmpty' | 'classic' | 'shape'

/** The token's issue (trimmed), or undefined when it has the shape of a fine-grained token. */
export function fineGrainedTokenIssue(token: string): TokenIssue | undefined {
  const text = token.trim()
  if (text === '') return 'tokenEmpty'
  if (OTHER_TOKEN.test(text)) return 'classic'
  return FINE_GRAINED_TOKEN.test(text) ? undefined : 'shape'
}

/** `owner/name` out of what the person typed (`owner/name`, or its github.com address), or null when it is neither. */
export function repositoryOf(text: string): string | null {
  const trimmed = text.trim()
  const named = GITHUB_ADDRESS.exec(trimmed)?.[1] ?? trimmed
  return isRepository(named) ? named : null
}

/** GitHub's new-token page for `repository`, prefilled: its owner, 90 days, Contents and Pull requests read and write. */
export function newTokenUrl(repository: string): string {
  const [owner = '', name = ''] = repository.split('/')
  const params = new URLSearchParams({
    name: `VoC agents ${name}`.slice(0, MAX_TOKEN_NAME),
    description: `VoC engineering agents: branches and pull requests on ${repository} only`,
    target_name: owner,
    expires_in: String(MAX_TOKEN_DAYS),
    contents: 'write',
    pull_requests: 'write',
  })
  return `${NEW_TOKEN_PAGE}?${params.toString()}`
}

/** How a token's expiry reads from its days left: not known, fine, within the warning, or past. */
export type TokenState = 'none' | 'ok' | 'soon' | 'expired'

export function tokenState(daysLeft: number | null): TokenState {
  if (daysLeft === null) return 'none'
  if (daysLeft <= 0) return 'expired'
  return daysLeft <= TOKEN_WARNING_DAYS ? 'soon' : 'ok'
}

/** The server's refusals of a token (its 422's `code`), each said in plain words by the dialog. */
export const TOKEN_REFUSAL_CODES = [
  'classic_token', 'not_accepted', 'no_expiry', 'expires_too_late', 'expired', 'not_found', 'private_repository',
  'archived', 'no_push', 'org_pending_approval', 'other_repositories',
] as const

export type TokenRefusalCode = (typeof TOKEN_REFUSAL_CODES)[number]

/** A refusal code the dialog knows, or null. */
export function knownRefusal(code: string | null): TokenRefusalCode | null {
  return TOKEN_REFUSAL_CODES.find((known) => known === code) ?? null
}
