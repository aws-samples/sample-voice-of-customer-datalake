/**
 * @fileoverview How the deployment's GitHub Issues source signs in (7.45.00): with its fine-grained token, or with
 * one of the deployment's GitHub Apps (Agents → Connections → Connect GitHub), whose short-lived token the ingestor
 * gets for exactly the run's repositories (Issues and Metadata, read-only) and revokes at the run's end.
 *
 * Since 7.50.02 connecting a repository through the App configures the source by itself (Agents → Connections: the
 * App's id, the repository added to `repos`, those added listed in `repos_managed`, one `owner/name` per line), so
 * this card is the advanced view: while its connections manage the source it says so ({@link GitHubSignIn.managed}),
 * the fields behind "Configure manually". The manual path is App-first: with at least one App and nothing stored that
 * decides otherwise it signs in with the App (the only one preselected, so Save writes its id; a choice among
 * several), the token behind "Use a fine-grained token instead". What is stored always wins: an App's id is the App;
 * `none` (saved when the token was chosen), or repositories saved without an App's id, is the token.
 *
 * Only on the deployment's card: outside a workspace, or in the deployment's scope (Administration → Sources → Source settings → Deployment,
 * workspace/configScope.ts) from any address, whose reads then send no `X-Workspace-Id`. A run in a workspace ignores
 * `github_app_id` (the Apps are the deployment's), so a workspace's card keeps its plain fields. The credentials route
 * skips an empty value (it never deletes one), so choosing the token saves `github_app_id` as {@link NO_APP}, which
 * the ingestor reads as no App.
 *
 * @module pages/Settings/githubSignIn
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { scopedKey, useConfigScope } from '../../workspace/configScope'
import type { GitHubApp } from '../../api/githubAppsApi'
import type { ConfigField, PluginManifest } from '../../plugins/types'

/** The plugin whose card offers the choice. */
const GITHUB_ISSUES_PLUGIN = 'github_issues'
/** The keys of the App's id, the token and the repositories in the plugin's credentials. */
const APP_ID_KEY = 'github_app_id'
const TOKEN_KEY = 'token'
const REPOS_KEY = 'repos'
/** The repositories the deployment's connections added to `repos` (written by the Agents API, never by this card). */
const MANAGED_KEY = 'repos_managed'
/** The stored values the card reads (`GET /integrations/github_issues/credentials`), per request scope (`scopedKey`). */
const STORED_KEYS = [APP_ID_KEY, REPOS_KEY, MANAGED_KEY]
/** What a source card read of its stored values (`GET /integrations/<plugin>/credentials`): its save reads it again. */
export const storedCredentialsKey = (pluginId: string) => ['integration-credentials', pluginId] as const
const STORED_KEY = [...storedCredentialsKey(GITHUB_ISSUES_PLUGIN), 'sign-in'] as const
/** What `github_app_id` holds once the token is chosen again: not an App's id, so no App. */
const NO_APP = 'none'
/** An App's id as GitHub numbers it. */
const APP_ID = /^[1-9]\d{0,19}$/

type SignInMethod = 'token' | 'app'

export interface GitHubSignIn {
  method: SignInMethod
  /** Choose how the source signs in: the pending credentials follow (the other way's field is dropped). */
  choose: (method: SignInMethod) => void
  /** The manifest's fields to show for the method chosen (the App itself is chosen apart, unless its list fails). */
  fields: ConfigField[]
  /** The credentials to show and save: the pending ones, with the only App when it is not stored yet. */
  credentials: Record<string, string>
  /** The deployment's Apps; undefined while their list is not read, or cannot be. */
  apps: GitHubApp[] | undefined
  /** The App the card signs in with: the one chosen, else the stored one, else the only one; '' for none. */
  appId: string
  chooseApp: (appId: string) => void
  /** The repositories the deployment's connections manage while the source signs in with an App ([]: not managed). */
  managed: string[]
}

interface SignInInputs {
  /** Whether the card is open for an administrator (the reads are admin-only). */
  enabled: boolean
  credentials: Record<string, string>
  onCredentialsChange: (credentials: Record<string, string>) => void
}

const without = (credentials: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(credentials).filter(([name]) => name !== key))

const lines = (value: string | undefined): string[] =>
  (value ?? '').split(/[\n,]/).map((line) => line.trim()).filter((line) => line !== '')

const storedApp = (stored: Readonly<Record<string, string>> | undefined): string => {
  const value = (stored?.[APP_ID_KEY] ?? '').trim()
  return APP_ID.test(value) ? value : ''
}

/** What the stored values decide (null: nothing yet): an App's id is the App, `none` or repositories alone the token. */
function storedMethod(stored: Readonly<Record<string, string>> | undefined): SignInMethod | null {
  if (stored === undefined) return null
  if (storedApp(stored) !== '') return 'app'
  return (stored[APP_ID_KEY] ?? '').trim() === NO_APP || lines(stored[REPOS_KEY]).length > 0 ? 'token' : null
}

/** What the card read: the stored values and the deployment's Apps (undefined: not read, or not readable). */
interface SignInRead {
  stored: Readonly<Record<string, string>> | undefined
  apps: GitHubApp[] | undefined
}

const onlyApp = (apps: GitHubApp[] | undefined): string => (apps?.length === 1 ? apps[0]?.app_id ?? '' : '')

/** The App named: the one pending, else the stored one, else the only one ('' for none). */
function namedApp(pending: string | undefined, saved: string, only: string): string {
  if (pending !== undefined && APP_ID.test(pending)) return pending
  return saved === '' ? only : saved
}

/**
 * How the card signs in (the person's choice, else what is stored, else the App once the deployment has one), the
 * App it names and the credentials it shows and saves: the pending ones, with the only App when nothing names one.
 */
function signInState(read: SignInRead, chosen: SignInMethod | null, credentials: Record<string, string>) {
  const method: SignInMethod = chosen ?? storedMethod(read.stored) ?? (read.apps !== undefined && read.apps.length > 0 ? 'app' : 'token')
  const saved = storedApp(read.stored)
  const only = onlyApp(read.apps)
  const pending = credentials[APP_ID_KEY]
  const preselect = method === 'app' && pending === undefined && saved === '' && only !== ''
  return {
    method,
    credentials: preselect ? { ...credentials, [APP_ID_KEY]: only } : credentials,
    appId: method === 'app' ? namedApp(pending, saved, only) : '',
    managed: saved === '' ? [] : lines(read.stored?.[MANAGED_KEY]),
  }
}

/** The fields a method hides: the other way's, and the App's id once the App is chosen by its name. */
function hiddenFields(method: SignInMethod, appsFailed: boolean): ReadonlySet<string> {
  if (method === 'token') return new Set([APP_ID_KEY])
  // (a list that cannot be read leaves the App's id typed by hand)
  return new Set(appsFailed ? [TOKEN_KEY] : [TOKEN_KEY, APP_ID_KEY])
}

/** The card's sign-in for the deployment's GitHub Issues source, or null for any other card (or a workspace's). */
export function useGitHubSignIn(manifest: PluginManifest, { enabled, credentials, onCredentialsChange }: SignInInputs): GitHubSignIn | null {
  const scope = useConfigScope()
  const workspace = useCurrentWorkspace()
  const inWorkspace = scope === 'workspace' && workspace !== null
  const applies = manifest.id === GITHUB_ISSUES_PLUGIN && !inWorkspace && manifest.config.some((field) => field.key === APP_ID_KEY)
  const [chosen, setChosen] = useState<SignInMethod | null>(null)
  const stored = useQuery({
    queryKey: scopedKey(STORED_KEY, scope),
    queryFn: () => api.getIntegrationCredentials(GITHUB_ISSUES_PLUGIN, STORED_KEYS, scope),
    enabled: applies && enabled,
  })
  const read = useQuery({
    queryKey: scopedKey(githubAppsKeys.list(), scope), queryFn: () => githubAppsApi.listIn(scope), enabled: applies && enabled,
    retry: false,
  })
  if (!applies) return null
  const apps = read.data?.apps
  const state = signInState({ stored: stored.data, apps }, chosen, credentials)
  const shown = state.credentials
  const choose = (next: SignInMethod) => {
    setChosen(next)
    onCredentialsChange(next === 'token'
      ? { ...without(shown, APP_ID_KEY), [APP_ID_KEY]: NO_APP }
      : without(without(shown, TOKEN_KEY), APP_ID_KEY))
  }
  const hidden = hiddenFields(state.method, read.isError)
  return {
    ...state, choose, apps,
    fields: manifest.config.filter((field) => !hidden.has(field.key)),
    chooseApp: (next: string) => { onCredentialsChange({ ...shown, [APP_ID_KEY]: next }) },
  }
}
