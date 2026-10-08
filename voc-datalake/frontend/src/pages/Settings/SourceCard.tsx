/**
 * @fileoverview Source card component for Settings page.
 * @module pages/Settings/SourceCard
 * 
 * Renders a data source configuration card based on plugin manifest.
 */

import { useState, useId } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Loader2, CheckCircle2, ChevronDown,
} from 'lucide-react'
import { IconGlyph } from '../../components/SourceIcon/SourceIcon'
import { manifestIcon } from '../../components/SourceIcon/sourceIcons'
import { api } from '../../api/client'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { ownValue } from '../Scrapers/scraper-helpers'
import { CredentialsSection, SetupInstructionsSection, WebhooksSection } from './SourceCardSections'
import S3ImportExplorer from '../../components/S3ImportExplorer/S3ImportExplorer'
import clsx from 'clsx'
import type { PluginManifest } from '../../plugins/types'

/** Shared by every SourceCard so the page makes one /sources/status call. */
const SOURCES_STATUS_KEY = ['sources-status'] as const

type SourcesStatus = Awaited<ReturnType<typeof api.getSourcesStatus>>

interface ScheduleState {
  readonly enabled: boolean
  readonly loading?: boolean
}

/**
 * One source's schedule toggle, read from the page-wide /sources/status query.
 *
 * Each card used to fetch the whole status map in its own effect, so N cards
 * meant N identical calls (5 in production, queuing from 1.5 s to 4.0 s). A
 * shared query key lets TanStack Query dedupe them; each card reads its own
 * entry, and a toggle writes its answer back into that shared entry.
 */
function useSourceSchedule(sourceId: string, apiEndpoint: string): {
  serverStatus: ScheduleState
  toggleEnabled: (enabled: boolean) => Promise<void>
} {
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)
  const { data } = useQuery({
    queryKey: SOURCES_STATUS_KEY,
    queryFn: () => api.getSourcesStatus(),
    enabled: apiEndpoint !== '',
  })
  const enabled = data === undefined ? false : (ownValue(data.sources, sourceId)?.enabled ?? false)

  const toggleEnabled = async (next: boolean) => {
    setLoading(true)
    try {
      const response = next ? await api.enableSource(sourceId) : await api.disableSource(sourceId)
      queryClient.setQueryData<SourcesStatus>(SOURCES_STATUS_KEY, (previous) => {
        const sources = previous?.sources ?? {}
        return { sources: { ...sources, [sourceId]: { ...ownValue(sources, sourceId), enabled: response.enabled } } }
      })
    } catch {
      // The toggle stays where it was; the card shows the server's last answer.
    } finally {
      setLoading(false)
    }
  }

  return { serverStatus: { enabled, loading }, toggleEnabled }
}

// ============================================
// Props Types
// ============================================

interface SourceCardProps {
  readonly manifest: PluginManifest
  readonly apiEndpoint: string
  /** Whether the current user is an admin. THREE things depend on it, all three
   *  because the route behind them is admin-gated server-side:
   *
   *    1. the integration-status query (`GET /integrations/status`) is not issued
   *       at all by a non-admin, avoiding a 403;
   *    2. the Enabled toggle (`PUT /sources/{source}/enable|disable`) is disabled
   *       rather than firing a request that fails;
   *    3. `Save to Secrets Manager` in `CredentialsSection`
   *       (`PUT /integrations/{source}/credentials`) likewise.
   *
   *  (3) is the worst of the three to leave ungated and was the last one found:
   *  `updateCredentialsMutation` has an `onSuccess` but no `onError`, so its 403
   *  rendered nothing — a non-admin typed a credential, clicked Save, and got no
   *  indication it had been refused. A disabled control fails visibly; that one
   *  failed silently. */
  readonly isAdmin: boolean
}

export default function SourceCard({ manifest, apiEndpoint, isAdmin }: SourceCardProps) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  // GET /integrations/status is admin-gated server-side; only issue the query
  // for admin users to prevent a 403 for regular authenticated users.
  const { data: integrationStatus } = useQuery({
    queryKey: ['integration-status'],
    queryFn: () => api.getIntegrationStatus(),
    enabled: isAdmin && !!apiEndpoint,
  })

  const sourceStatus = integrationStatus?.[manifest.id]
  const { serverStatus, toggleEnabled } = useSourceSchedule(manifest.id, apiEndpoint)

  const updateCredentialsMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => api.updateIntegrationCredentials(manifest.id, creds),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      void queryClient.invalidateQueries({ queryKey: ['integration-status'] })
    },
  })

  const testMutation = useMutation({
    mutationFn: () => api.testIntegration(manifest.id),
  })

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text)
    setCopiedUrl(id)
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  const webhookBaseUrl = apiEndpoint ? `${apiEndpoint}webhooks/` : ''

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <SourceCardHeader
        manifest={manifest}
        sourceStatus={sourceStatus}
        serverStatus={serverStatus}
        apiEndpoint={apiEndpoint}
        isAdmin={isAdmin}
        isExpanded={isExpanded}
        onToggleExpand={() => setIsExpanded(!isExpanded)}
        onToggleEnabled={toggleEnabled}
      />

      {isExpanded && (
        <div className="p-3 sm:p-4 border-t border-border space-y-4 sm:space-y-6">
          {manifest.webhooks && manifest.webhooks.length > 0 && (
            <WebhooksSection
              webhooks={manifest.webhooks}
              sourceKey={manifest.id}
              webhookBaseUrl={webhookBaseUrl}
              copiedUrl={copiedUrl}
              onCopy={copyToClipboard}
            />
          )}

          {manifest.config.length > 0 && (
            <CredentialsSection
              fields={manifest.config}
              credentials={credentials}
              showSecrets={showSecrets}
              sourceStatus={sourceStatus}
              saveSuccess={saveSuccess}
              isAdmin={isAdmin}
              testMutation={testMutation}
              updateCredentialsMutation={updateCredentialsMutation}
              onCredentialsChange={setCredentials}
              onToggleSecrets={() => setShowSecrets(!showSecrets)}
            />
          )}

          {manifest.setup && (
            <SetupInstructionsSection setup={manifest.setup} />
          )}

          {manifest.id === 's3_import' && apiEndpoint && (
            <div>
              <h4 className="text-sm font-semibold text-text mb-2 sm:mb-3 flex items-center gap-2">
                {t('sourceCard.fileExplorer')}
              </h4>
              <S3ImportExplorer />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Sub-Components
// ============================================

interface SourceCardHeaderProps {
  readonly manifest: PluginManifest
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly serverStatus: { enabled: boolean; loading?: boolean }
  readonly apiEndpoint: string
  /** `PUT /sources/{source}/enable|disable` is admin-gated server-side, so the
   *  toggle below is disabled for a non-admin rather than issuing a request whose
   *  403 `toggleEnabled`'s empty `catch` would swallow — leaving the checkbox to
   *  revert with no explanation. The server is the boundary; this is the reason. */
  readonly isAdmin: boolean
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onToggleEnabled: (enabled: boolean) => void
}

/**
 * Manifest `icon` values are plain words (`Web`, `iOS`, `GitHub`, …); they map to
 * the shared lucide set (components/SourceIcon) so every card shows the same 16px
 * glyph in the same tile, never an emoji or raw text.
 */
function ManifestIconTile({ icon, category }: Readonly<{ icon: string; category?: string }>) {
  return (
    <span
      aria-hidden="true"
      data-testid="source-icon"
      className="flex-shrink-0 w-9 h-9 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center"
    >
      <IconGlyph icon={manifestIcon(icon, category)} size={16} />
    </span>
  )
}

function SourceCardHeader({ manifest, sourceStatus, serverStatus, apiEndpoint, isAdmin, isExpanded, onToggleExpand, onToggleEnabled }: SourceCardHeaderProps) {
  const { t } = useTranslation('settings')
  const nameId = useId()
  const statusId = useId()
  // The row is a plain container with two independent controls — the expand
  // button and the enable switch — so neither is nested inside the other.
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between p-3 sm:p-4 hover:bg-bg-hover transition-colors gap-2 sm:gap-3">
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-md focus-ring"
      >
        <ManifestIconTile icon={manifest.icon} category={manifest.category} />
        <span className="min-w-0">
          <span id={nameId} className="block font-medium text-sm text-text-strong truncate">{manifest.name}</span>
          {manifest.description && <span className="text-xs text-muted line-clamp-1" title={manifest.description}>{manifest.description}</span>}
        </span>
      </button>
      <div className="flex items-center gap-3 ml-auto sm:ml-0 flex-shrink-0">
        {sourceStatus?.configured && (
          <span className="badge badge-ok flex items-center gap-1">
            <CheckCircle2 size={12} /> {t('sourceCard.connected')}
          </span>
        )}
        <label
          className="flex items-center gap-2 min-h-9"
          title={isAdmin ? undefined : ADMIN_ONLY_TITLE}
        >
          {serverStatus.loading ? (
            <Loader2 size={16} className="animate-spin text-accent" />
          ) : (
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={serverStatus.enabled}
                onChange={(e) => onToggleEnabled(e.target.checked)}
                disabled={!apiEndpoint || !isAdmin}
                aria-labelledby={`${nameId} ${statusId}`}
                className="peer sr-only"
              />
              {/* KiroCrew toggle: the input stays the accessible control; these spans are its visual track and knob. */}
              <span
                aria-hidden="true"
                className={clsx(
                  'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50 peer-disabled:cursor-not-allowed',
                  serverStatus.enabled && 'switch-on'
                )}
              >
                <span className="switch-knob" />
              </span>
            </span>
          )}
          <span id={statusId} className="text-xs sm:text-sm text-text w-16">{serverStatus.enabled ? t('sourceCard.enabled') : t('sourceCard.disabled')}</span>
        </label>
        {/* Mouse convenience only: the labelled, focusable expand control is the button above. */}
        <button
          type="button"
          onClick={onToggleExpand}
          aria-hidden="true"
          tabIndex={-1}
          className="icon-btn"
        >
          <ChevronDown size={16} className={clsx('transition-transform', isExpanded && 'rotate-180')} />
        </button>
      </div>
    </div>
  )
}
