/**
 * Real Cognito login through the app's own /login page, and helpers to read
 * the resulting id token out of the saved storage state (for direct API calls).
 * Credentials and tokens are never logged.
 */
import fs from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { isRecord } from './guards'
import { credentials, siteUrl, storageStatePath, type Role } from './env'

export async function loginThroughUi(page: Page, role: Role): Promise<void> {
  const { username, password } = credentials(role)
  await page.goto(`${siteUrl()}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Username or Email').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // A NEW_PASSWORD_REQUIRED challenge would stop here; the e2e users are confirmed.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 })
}

interface StoredOrigin {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

function originsOf(raw: unknown): StoredOrigin[] {
  if (!isRecord(raw) || !Array.isArray(raw['origins'])) return []
  return raw['origins'].filter((o): o is StoredOrigin =>
    isRecord(o) && typeof o['origin'] === 'string' && Array.isArray(o['localStorage']))
}

/** The id token the SPA sends as `Authorization` (raw, no Bearer prefix). */
export function idTokenFor(role: Role): string {
  const raw: unknown = JSON.parse(fs.readFileSync(storageStatePath(role), 'utf8'))
  for (const origin of originsOf(raw)) {
    const entry = origin.localStorage.find((item) => item.name === 'voc-auth')
    if (entry === undefined) continue
    const parsed: unknown = JSON.parse(entry.value)
    const state = isRecord(parsed) ? parsed['state'] : undefined
    const token = isRecord(state) ? state['idToken'] : undefined
    if (typeof token === 'string' && token !== '') return token
  }
  throw new Error(`No id token in the saved ${role} session; run the setup project first`)
}

/** One claim of the signed-in role's id token (decoded, not verified: the API verifies it). */
function idTokenClaim(role: Role, claim: string): unknown {
  const payload = idTokenFor(role).split('.')[1] ?? ''
  const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  return isRecord(claims) ? claims[claim] : undefined
}

/** Cognito username of the signed-in role, from the id token's claims. */
export function cognitoUsernameFor(role: Role): string {
  const name = idTokenClaim(role, 'cognito:username')
  return typeof name === 'string' ? name : credentials(role).username
}

/** Cognito `sub` of the signed-in role (what project membership is keyed by). */
export function cognitoSubFor(role: Role): string {
  const sub = idTokenClaim(role, 'sub')
  if (typeof sub !== 'string' || sub === '') throw new Error(`No sub in the saved ${role} session`)
  return sub
}
