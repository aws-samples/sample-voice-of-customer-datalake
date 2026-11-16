/**
 * @fileoverview How the deployment's GitHub Issues source signs in (7.45.00): with its fine-grained token, or with
 * one of the deployment's GitHub Apps (Agents → Connections → Connect GitHub), whose short-lived token the ingestor
 * gets for exactly the run's repositories (Issues and Metadata, read-only) and revokes at the run's end.
 *
 * Only on the deployment's card: outside a workspace, or in the deployment's scope (Administration → Data sources,
 * workspace/configScope.ts) from any address, whose reads then send no `X-Workspace-Id`. A run in a workspace ignores
 * `github_app_id` (the Apps are the deployment's), so a workspace's card keeps its plain fields. The choice is the stored `github_app_id`: an App's id signs in with that App,
 * anything else with the token. The credentials route skips an empty value (it never deletes one), so choosing the
 * token saves `github_app_id` as {@link NO_APP}, which the ingestor reads as no App.
 *
 * @module pages/Settings/githubSignIn
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { scopedKey, useConfigScope } from '../../workspace/configScope'
import type { ConfigField, PluginManifest } from '../../plugins/types'

/** The plugin whose card offers the choice. */
const GITHUB_ISSUES_PLUGIN = 'github_issues'
/** The key of the App's id, and of the token, in the plugin's credentials. */
const APP_ID_KEY = 'github_app_id'
const TOKEN_KEY = 'token'
/** The stored App id's read (`GET /integrations/github_issues/credentials`), scoped per request scope (`scopedKey`). */
const STORED_APP_KEY = ['integration-credentials', GITHUB_ISSUES_PLUGIN, APP_ID_KEY] as const
/** What `github_app_id` holds once the token is chosen again: not an App's id, so no App. */
const NO_APP = 'none'
/** An App's id as GitHub numbers it. */
const APP_ID = /^[1-9]\d{0,19}$/

export type SignInMethod = 'token' | 'app'

export interface GitHubSignIn {
  method: SignInMethod
  /** Choose how the source signs in: the pending credentials follow (the other way's field is dropped). */
  choose: (method: SignInMethod) => void
  /** The credential fields to show for the method chosen. */
  fields: ConfigField[]
}

interface SignInInputs {
  /** Whether the card is open for an administrator (the reads are admin-only). */
  enabled: boolean
  credentials: Record<string, string>
  onCredentialsChange: (credentials: Record<string, string>) => void
}

const without = (credentials: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(credentials).filter(([name]) => name !== key))

/** The card's sign-in choice for the deployment's GitHub Issues source, or null for any other card (or a workspace's). */
export function useGitHubSignIn(manifest: PluginManifest, { enabled, credentials, onCredentialsChange }: SignInInputs): GitHubSignIn | null {
  const { t } = useTranslation('settings')
  const scope = useConfigScope()
  const workspace = useCurrentWorkspace()
  const inWorkspace = scope === 'workspace' && workspace !== null
  const applies = manifest.id === GITHUB_ISSUES_PLUGIN && !inWorkspace && manifest.config.some((field) => field.key === APP_ID_KEY)
  const [chosen, setChosen] = useState<SignInMethod | null>(null)
  const stored = useQuery({
    queryKey: scopedKey(STORED_APP_KEY, scope),
    queryFn: () => api.getIntegrationCredentials(GITHUB_ISSUES_PLUGIN, [APP_ID_KEY], scope),
    enabled: applies && enabled,
  })
  const apps = useQuery({
    queryKey: scopedKey(githubAppsKeys.list(), scope), queryFn: () => githubAppsApi.listIn(scope), enabled: applies && enabled,
    retry: false,
  })
  if (!applies) return null
  const method = chosen ?? (APP_ID.test(stored.data?.[APP_ID_KEY] ?? '') ? 'app' : 'token')
  const choose = (next: SignInMethod) => {
    setChosen(next)
    onCredentialsChange(next === 'token'
      ? { ...without(credentials, APP_ID_KEY), [APP_ID_KEY]: NO_APP }
      : without(without(credentials, TOKEN_KEY), APP_ID_KEY))
  }
  const appField = (field: ConfigField): ConfigField => (apps.data === undefined ? field : {
    ...field, type: 'select', label: t('sourceCard.githubSignIn.appLabel'), required: true,
    options: apps.data.apps.map((app) => ({ value: app.app_id, label: `${app.slug} (${app.owner})` })),
  })
  const fields = manifest.config
    .filter((field) => field.key !== (method === 'app' ? TOKEN_KEY : APP_ID_KEY))
    .map((field) => (field.key === APP_ID_KEY ? appField(field) : field))
  return { method, choose, fields }
}
