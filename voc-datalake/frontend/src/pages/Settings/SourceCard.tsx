/**
 * @fileoverview Source card component for Settings page.
 * @module pages/Settings/SourceCard
 * 
 * Renders a data source configuration card based on plugin manifest. Its reads and writes are the current
 * workspace's, or in the deployment's scope (Administration → Sources → Source settings → Deployment, workspace/configScope.ts) the
 * deployment's, inside a workspace too: they then never send `X-Workspace-Id`. A card the address opens
 * (`/admin/sources/plugins/<source>`, `initiallyOpen`) starts expanded and is scrolled into view.
 */

import { useEffect, useRef, useState, useId, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { usePluginCopy } from '../../plugins/pluginCopy'
import {
  Loader2, CheckCircle2, ChevronDown,
} from 'lucide-react'
import { IconGlyph } from '../../components/SourceIcon/SourceIcon'
import { manifestIcon } from '../../components/SourceIcon/sourceIcons'
import { api } from '../../api/client'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { useAdminOnlyReason } from '../../hooks/useAdminOnlyReason'
import { SetupInstructionsSection, WebhooksSection } from './SourceCardSections'
import SourceCredentials from './SourceCredentials'
import { storedCredentialsKey } from './githubSignIn'
import SourceCircuitNotice from './SourceCircuitNotice'
import { useSourceSchedule } from './useSourceSchedule'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import S3ImportExplorer from '../../components/S3ImportExplorer/S3ImportExplorer'
import { scopedKey, useConfigScope } from '../../workspace/configScope'
import clsx from 'clsx'
import type { PluginManifest } from '../../plugins/types'

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
  /** The card the address opens (`/admin/sources/plugins/<source>`): it starts expanded, scrolled into view. */
  readonly initiallyOpen?: boolean
}

/**
 * Sources whose settings ARE a raw technical configuration (the web scraper's
 * JSON list, which the Data sources page edits for you): shown collapsed under
 * "Advanced", never deleted. Every other source's token stays in view.
 */
const RAW_CONFIG_SOURCES: ReadonlySet<string> = new Set(['webscraper'])

/** Which sources have credentials set (`GET /integrations/status`), scoped per request scope (`scopedKey`). */
const INTEGRATION_STATUS_KEY = ['integration-status'] as const

/** The card's element, scrolled into view once, on mount, when the address opens it (a later expand scrolls nothing). */
function useOpenedCard(opened: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (opened) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [opened])
  return ref
}

function AdvancedWhenRaw({ sourceId, children }: Readonly<{ sourceId: string; children: ReactNode }>) {
  const { t } = useTranslation('settings')
  if (!RAW_CONFIG_SOURCES.has(sourceId)) return <>{children}</>
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium text-text-strong focus-ring rounded-sm">{t('sourceCard.advanced')}</summary>
      <p className="text-xs text-muted mt-2 mb-3">{t('sourceCard.advancedRawHint')}</p>
      {children}
    </details>
  )
}

export default function SourceCard({ manifest, apiEndpoint, isAdmin, initiallyOpen }: SourceCardProps) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const scope = useConfigScope()
  const [isExpanded, setIsExpanded] = useState(initiallyOpen === true)
  const cardRef = useOpenedCard(initiallyOpen === true)
  const [showSecrets, setShowSecrets] = useState(false)
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  // "Saved" until the next edit of the credentials (components/SavedStatus).
  const [saveSuccess, setSaveSuccess] = useState(false)
  const { copy: copyToClipboard, copiedKey: copiedUrl } = useCopyToClipboard()

  // GET /integrations/status is admin-gated server-side; only issue the query
  // for admin users to prevent a 403 for regular authenticated users.
  const { data: integrationStatus } = useQuery({
    queryKey: scopedKey(INTEGRATION_STATUS_KEY, scope),
    queryFn: () => api.getIntegrationStatus(scope),
    enabled: isAdmin && !!apiEndpoint,
  })

  const sourceStatus = integrationStatus?.[manifest.id]
  const { serverStatus, toggleEnabled, resetCircuit } = useSourceSchedule(manifest.id, apiEndpoint)

  const updateCredentialsMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => api.updateIntegrationCredentials(manifest.id, creds, scope),
    onSuccess: () => {
      setSaveSuccess(true)
      void queryClient.invalidateQueries({ queryKey: scopedKey(INTEGRATION_STATUS_KEY, scope) })
      // (what the card read of its stored values, the GitHub Issues card's sign-in: githubSignIn.ts)
      void queryClient.invalidateQueries({ queryKey: storedCredentialsKey(manifest.id) })
    },
  })

  const webhookBaseUrl = apiEndpoint ? `${apiEndpoint}webhooks/` : ''

  return (
    <div ref={cardRef} className="border border-border rounded-lg overflow-hidden scroll-mt-4">
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

      <SourceCircuitNotice
        circuit={serverStatus.circuit}
        isAdmin={isAdmin}
        resetting={serverStatus.resetting}
        resetFailed={serverStatus.resetFailed}
        onReset={() => void resetCircuit()}
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
            <AdvancedWhenRaw sourceId={manifest.id}>
              <SourceCredentials
                manifest={manifest}
                apiEndpoint={apiEndpoint}
                credentials={credentials}
                showSecrets={showSecrets}
                saveSuccess={saveSuccess}
                isAdmin={isAdmin}
                updateCredentialsMutation={updateCredentialsMutation}
                onCredentialsChange={(next) => { setSaveSuccess(false); setCredentials(next) }}
                onToggleSecrets={() => setShowSecrets(!showSecrets)}
              />
            </AdvancedWhenRaw>
          )}

          {manifest.setup && (
            <SetupInstructionsSection setup={manifest.setup} />
          )}

          {manifest.id === 's3_import' && apiEndpoint && (
            <div>
              <h4 className="text-sm font-semibold text-text mb-2 sm:mb-3 flex items-center gap-2">
                {t('sourceCard.fileExplorer')}
              </h4>
              {/* Every /s3-import/* route is admin-only (#242): a
                  non-admin is told so instead of an explorer whose every call 403s. */}
              {isAdmin
                ? <S3ImportExplorer />
                : <p className="text-sm text-muted">{t('components:s3Import.adminOnly')}</p>}
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
  readonly serverStatus: { enabled: boolean; exists?: boolean; loading?: boolean }
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

/**
 * A source with no schedule rule (`GET /sources/status` answers `exists: false`: its manifest declares no
 * `schedule`) has nothing to switch on or off, and `PUT /sources/{source}/enable` answers 400 for it. It says how it
 * runs instead: the S3 import on an upload to its bucket, the others when someone starts them.
 */
function NoScheduleLabel({ manifest }: Readonly<{ manifest: PluginManifest }>) {
  const { t } = useTranslation('settings')
  const label = manifest.hasS3Trigger ? t('sourceCard.runsOnUpload') : t('sourceCard.runsOnDemand')
  return <span className="text-xs sm:text-sm text-muted min-h-9 inline-flex items-center">{label}</span>
}

function SourceCardHeader({ manifest, sourceStatus, serverStatus, apiEndpoint, isAdmin, isExpanded, onToggleExpand, onToggleEnabled }: SourceCardHeaderProps) {
  const { t } = useTranslation('settings')
  const copy = usePluginCopy()(manifest)
  const nameId = useId()
  const statusId = useId()
  const adminOnly = useAdminOnlyReason(isAdmin)
  // The row is a plain container with two independent controls — the expand
  // button (name, description, chevron) and the enable switch — so neither is nested inside the other.
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
          <span id={nameId} className="block font-medium text-sm text-text-strong break-words hyphens-auto">{copy.name}</span>
          {copy.description && <span className="text-xs text-muted break-words [overflow-wrap:anywhere]">{copy.description}</span>}
        </span>
        {/* The chevron sits INSIDE the named expand button: a second, icon-only button had no name (5.34.00). */}
        <ChevronDown size={16} aria-hidden="true" className={clsx('ml-auto flex-shrink-0 text-muted transition-transform', isExpanded && 'rotate-180')} />
      </button>
      <div className="flex flex-wrap items-center justify-end gap-3 ml-auto sm:ml-0 flex-shrink-0 max-w-full">
        {sourceStatus?.configured && (
          <span className="badge badge-ok flex items-center gap-1">
            <CheckCircle2 size={12} /> {t('sourceCard.connected')}
          </span>
        )}
        {serverStatus.exists === false ? <NoScheduleLabel manifest={manifest} /> : (
        // (the reason on the label, the switch's visible part: its input is the sr-only peer)
        <Tooltip kind="description" content={adminOnly}><label className="flex items-center gap-2 min-h-9">
          {serverStatus.loading ? (
            <Loader2 size={16} className="animate-spin text-accent" />
          ) : (
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={serverStatus.enabled}
                onChange={(e) => { if (isAdmin) onToggleEnabled(e.target.checked) }}
                disabled={!apiEndpoint}
                aria-disabled={isAdmin ? undefined : true}
                aria-labelledby={`${nameId} ${statusId}`}
                className="peer sr-only"
              />
              {/* KiroCrew toggle: the input stays the accessible control; these spans are its visual track and knob. */}
              <span
                aria-hidden="true"
                className={clsx(
                  'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50 peer-disabled:cursor-not-allowed',
                  'peer-aria-disabled:opacity-50 peer-aria-disabled:cursor-not-allowed',
                  serverStatus.enabled && 'switch-on'
                )}
              >
                <span className="switch-knob" />
              </span>
            </span>
          )}
          <span id={statusId} className="text-xs sm:text-sm text-text w-16">{serverStatus.enabled ? t('sourceCard.enabled') : t('sourceCard.disabled')}</span>
        </label></Tooltip>
        )}
      </div>
    </div>
  )
}
