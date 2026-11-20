/**
 * @fileoverview The deployment's GitHub Apps for the engineering agents (7.45.00, administrators only, while the
 * engineering agents are on): the in-app connect flow, built on a GitHub App manifest.
 *
 * 1. `POST /agents/engineering/github-apps/manifest` answers the form GitHub's "Create GitHub App" page takes (its
 *    address, with a single-use state, and the manifest the server wrote); the page posts it to github.com.
 * 2. GitHub sends the person back with a `code` and the state: `POST …/github-apps/conversions` exchanges the code
 *    on the server (the App's key goes straight to SSM, never to the page) and answers the App and its install link.
 * 3. GitHub sends the person back from the installation: `POST …/github-apps/installations` saves a connection for
 *    every repository the installation covers (up to the connection limit).
 *
 * Beside them: the list (`GET …/github-apps`), a new install link (`POST …/<app_id>/install`), a check of the
 * installation against the App's connections (`POST …/<app_id>/check`) and the App's removal (`DELETE …/<app_id>`,
 * refused while connections use it). Since 7.50.02 the installation's and the check's answers say what followed for the
 * deployment's GitHub Issues source (`issues`: api/issuesSourceApi.ts): their repositories read automatically, each
 * one's `voc-agent` label. No answer carries a key, a secret or a token. The addresses the page sends the
 * browser to are taken only on github.com: an answer naming another host is unreadable, never followed.
 *
 * @module api/githubAppsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { del, post } from './requestKit'
import { parseEach } from './lenientFields'
import { optionalServerText, parseConnection, parseLimitedList } from './engineeringConnectionsApi'
import { parseIssuesFollow } from './issuesSourceApi'
import { isRecord } from '../lib/typeGuards'
import type { RequestScope } from './baseUrl'
import type { SavedConnection } from './engineeringConnectionsApi'
import type { IssuesFollow } from './issuesSourceApi'

/** The most Apps a deployment keeps (the answer's `limit` wins when it gives one). */
const DEFAULT_APP_LIMIT = 5
/** Where the browser may be sent: GitHub's own pages, nowhere else. */
const GITHUB_ORIGIN = 'https://github.com/'

/** A github.com address, or '' for anything else (the App's page is then not linked). */
const githubPage = z.string().catch('').transform((url) => (url.startsWith(GITHUB_ORIGIN) ? url : ''))

const AppSchema = z.object({
  app_id: z.string().regex(/^[1-9]\d{0,19}$/),
  slug: z.string().min(1),
  owner: z.string().catch(''),
  /** The account the App belongs to: a person's (`User`) or an organization's. */
  owner_type: z.enum(['User', 'Organization']).catch('User'),
  html_url: githubPage,
  /** Whether the App delivers issue events to this deployment's GitHub Issues webhook. */
  webhook: z.boolean().catch(false),
  /** The ids of the connections that use the App's key. */
  connections: z.array(z.string()).catch([]),
  created_at: optionalServerText(),
  created_by: optionalServerText(),
  version: z.number().int().catch(0),
})

export type GitHubApp = z.output<typeof AppSchema>

export interface GitHubAppList {
  apps: GitHubApp[]
  limit: number
}

/** Whose account the App is created in: the person's own, or an organization's (by its login). */
/** The account the App is made on, and the workspace the flow starts in (its slug: GitHub's return comes back into it). */
export type ManifestRequest = ({ account: 'user' } | { account: 'organization'; org: string }) & { workspace?: string }

/** An organization's login as GitHub takes it (letters, digits and single hyphens, at most 39 characters). */
export const ORGANIZATION_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/

export interface ManifestForm {
  /** github.com's "Create GitHub App" page for the account, with the single-use state in its query. */
  actionUrl: string
  /** The manifest the server wrote, posted as is. */
  manifest: Record<string, unknown>
  expiresAt: string
}

export interface InstallLink {
  /** github.com's installation page of the App, with a single-use state (good for 30 minutes). */
  installUrl: string
}

export interface CreatedApp extends InstallLink {
  app: GitHubApp
}

const SKIP_REASONS = ['archived', 'already_connected', 'limit', 'not_saved'] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

interface SkippedRepository {
  repository: string
  reason: SkipReason
}

export interface Installation {
  app: GitHubApp
  /** The account the App was installed on (its GitHub login). */
  account: { login: string }
  connections: SavedConnection[]
  skipped: SkippedRepository[]
  /** What followed for the deployment's GitHub Issues source (7.50.02), or null when none is deployed here. */
  issues: IssuesFollow | null
  /** (7.57.00) An installation on a fork, started from "Contribute to ‹upstream›" (step 2): the upstream and the fork. */
  fork: { upstream: string; repository: string } | null
}

export interface InstallationReturn {
  installationId: number
  setupAction: 'install' | 'update'
  state: string
}

export interface InstallationCheck {
  /** The repositories the App's installations cover (`owner/name`). */
  repositories: string[]
  /** The connections whose repository they no longer cover. */
  missing: string[]
  /** What followed for the deployment's GitHub Issues source (7.50.02), or null when none is deployed here. */
  issues: IssuesFollow | null
}

const SkippedSchema = z.object({ repository: z.string().min(1), reason: z.enum(SKIP_REASONS).catch('not_saved') })

const unreadable = (what: string): Error => new Error(`The ${what} answer was unreadable`)

function parseApp(raw: unknown, what: string): GitHubApp {
  const app = AppSchema.safeParse(raw)
  if (!app.success) throw unreadable(what)
  return app.data
}

/** A github.com address the answer carries under `key`, or the answer is unreadable. */
function githubUrl(raw: Record<string, unknown>, key: string, what: string): string {
  const url = raw[key]
  if (typeof url !== 'string' || !url.startsWith(GITHUB_ORIGIN)) throw unreadable(what)
  return url
}

const text = (raw: Record<string, unknown>, key: string): string => {
  const value = raw[key]
  return typeof value === 'string' ? value : ''
}

function parseAppList(raw: unknown): GitHubAppList {
  const { items, limit } = parseLimitedList(raw, 'apps', AppSchema, DEFAULT_APP_LIMIT, unreadable('GitHub Apps').message)
  return { apps: items, limit }
}

function parseManifestForm(raw: unknown): ManifestForm {
  if (!isRecord(raw) || !isRecord(raw.manifest)) throw unreadable('GitHub App manifest')
  return { actionUrl: githubUrl(raw, 'action_url', 'GitHub App manifest'), manifest: raw.manifest, expiresAt: text(raw, 'expires_at') }
}

function parseInstallLink(raw: unknown, what: string): InstallLink {
  if (!isRecord(raw)) throw unreadable(what)
  return { installUrl: githubUrl(raw, 'install_url', what) }
}

function parseCreatedApp(raw: unknown): CreatedApp {
  const link = parseInstallLink(raw, 'GitHub App')
  return { ...link, app: parseApp(isRecord(raw) ? raw.app : undefined, 'GitHub App') }
}

function parseSaved(raw: unknown): SavedConnection[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown) => {
    const connection = isRecord(entry) ? parseConnection(entry.connection) : null
    return connection === null || !isRecord(entry) ? [] : [{ connection, created: entry.created === true }]
  })
}

function parseFork(raw: unknown): Installation['fork'] {
  if (!isRecord(raw)) return null
  const upstream = text(raw, 'upstream')
  const repository = text(raw, 'repository')
  return upstream === '' || repository === '' ? null : { upstream, repository }
}

function parseInstallation(raw: unknown): Installation {
  if (!isRecord(raw) || !Array.isArray(raw.connections) || !isRecord(raw.account)) throw unreadable('installation')
  return {
    app: parseApp(raw.app, 'installation'),
    account: { login: text(raw.account, 'login') },
    connections: parseSaved(raw.connections),
    skipped: parseEach(SkippedSchema, raw.skipped),
    issues: parseIssuesFollow(raw.issues),
    fork: parseFork(raw.fork),
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string')
  : [])

function parseCheck(raw: unknown): InstallationCheck {
  if (!isRecord(raw) || !Array.isArray(raw.repositories) || !Array.isArray(raw.missing)) throw unreadable('installation check')
  return { repositories: strings(raw.repositories), missing: strings(raw.missing), issues: parseIssuesFollow(raw.issues) }
}

const APPS_PATH = '/agents/engineering/github-apps'
const appPath = (appId: string) => `/agents/engineering/github-apps/${encodeURIComponent(appId)}`

export const githubAppsKeys = { list: () => ['engineering-github-apps'] as const }

/** The deployment's Apps; `scope` 'deployment' sends no `X-Workspace-Id` (the deployment's Data sources). */
async function listApps(scope: RequestScope): Promise<GitHubAppList> {
  return parseAppList(await fetchApi<unknown>(APPS_PATH, { method: 'GET' }, scope))
}

export const githubAppsApi = {
  list: async (): Promise<GitHubAppList> => listApps('workspace'),
  /** The list, read in `scope` (the GitHub Issues card's App choice, which is the deployment's). */
  listIn: listApps,
  /** The form to post to github.com for a new App in `request`'s account. */
  manifest: async (request: ManifestRequest): Promise<ManifestForm> =>
    parseManifestForm(await fetchApi<unknown>(`${APPS_PATH}/manifest`, post(request))),
  /** Exchange the code GitHub sent back for the App (its key stored on the server), and its install link. */
  convert: async (code: string, state: string): Promise<CreatedApp> =>
    parseCreatedApp(await fetchApi<unknown>(`${APPS_PATH}/conversions`, post({ code, state }))),
  /** A new install link for the App (to install it on more repositories, or on another account). */
  install: async (appId: string): Promise<InstallLink> =>
    parseInstallLink(await fetchApi<unknown>(`${appPath(appId)}/install`, post({})), 'install link'),
  /** Save a connection for every repository the installation GitHub sent the person back from covers. */
  installed: async ({ installationId, setupAction, state }: InstallationReturn): Promise<Installation> =>
    parseInstallation(await fetchApi<unknown>(`${APPS_PATH}/installations`, post({
      installation_id: installationId, setup_action: setupAction, state,
    }))),
  /** Which repositories the App's installations cover, and which of its connections they no longer do. */
  check: async (appId: string): Promise<InstallationCheck> =>
    parseCheck(await fetchApi<unknown>(`${appPath(appId)}/check`, post({}))),
  /** Remove the App's stored key and its row (refused, 409, while connections use it). */
  remove: async (appId: string, reason = ''): Promise<void> => {
    await fetchApi<unknown>(appPath(appId), del(reason.trim() === '' ? {} : { reason: reason.trim() }))
  },
}
