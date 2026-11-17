/**
 * @fileoverview A repository connection's details (7.52.00, ux-agents-redesign part 1 §2.6): the ids and the facts a
 * row no longer shows as content. An `icon-btn` (ⓘ, "Connection details for <repository>", its Tooltip the same words)
 * opens a non-modal `role="dialog"` in the `menu` look, `w-72`, beside it: the connection id, the GitHub App id and
 * the installation id in `font-mono`, each with a copy button ("Copied" announced), the default branch, the host and
 * the credential's kind, "Key: Stored, never shown" (or that it is missing), a GitLab token's expiry, the CI
 * attestation's who and when (or why none holds), the `voc-agent` label's state, and the last change.
 *
 * Focus moves into it when it opens and back to the button when it closes (hooks/useOverlayFocus.ts); Escape, a press
 * outside, Tab out of it, a scroll or a resize close it. It is fixed and in a portal (utils/fixedMenu.ts), so a list
 * card's `overflow-hidden` never clips it. Nothing here is a secret: a stored key or token is never sent to the page.
 *
 * @module pages/Agents/ConnectionDetails
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Copy, Info } from 'lucide-react'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { useCloseOnViewportChange } from '../../hooks/useCloseOnViewportChange'
import { useOverlayFocus } from '../../hooks/useOverlayFocus'
import { noCleanup } from '../../hooks/noCleanup'
import { placeFixedMenu } from '../../utils/fixedMenu'
import { formatCalendarDay, formatDateTime } from '../../utils/dateUtils'
import { useAttestationText } from './connectionText'
import type { RefObject } from 'react'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { ConnectionIssues } from '../../api/issuesSourceApi'

/** One id, in mono, with its copy button. */
function CopyableId({ label, value, copied, onCopy }: Readonly<{
  label: string; value: string; copied: boolean; onCopy: () => void
}>) {
  const { t } = useTranslation('agents')
  const name = t('connections.details.copy', { field: label })
  return (
    <div className="py-1">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-mono text-[12px] text-text-strong break-all">{value}</span>
        <Tooltip kind="label" content={copied ? t('connections.details.copied') : name}>
          <button type="button" className="icon-btn shrink-0" aria-label={name} onClick={onCopy}>
            <Copy size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </dd>
    </div>
  )
}

/** One plain fact. */
function Fact({ label, children }: Readonly<{ label: string; children: string }>) {
  return (
    <div className="py-1">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="text-[12px] text-text break-words [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

/** While open, a press anywhere but the popover and its button closes it (focus stays where the press put it). */
function useCloseOnPressOutside(open: boolean, close: () => void, panel: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return noCleanup
    const controller = new AbortController()
    document.addEventListener('mousedown', (event) => {
      const path = event.composedPath()
      const kept = [panel.current, button.current].some((element) => element !== null && path.includes(element))
      if (!kept) close()
    }, { signal: controller.signal })
    return () => controller.abort()
  }, [open, close, panel, button])
}

/** The ids, each copyable (a connection made through an App or with a pasted key has an App and an installation). */
function Ids({ connection, copiedKey, onCopy }: Readonly<{
  connection: EngineeringConnection; copiedKey: string | null; onCopy: (value: string, key: string) => void
}>) {
  const { t } = useTranslation('agents')
  const { app_id: appId, installation_id: installationId } = connection.credential
  const ids = [
    { key: 'connection', label: t('connections.details.connectionId'), value: connection.connection_id },
    ...(appId === null ? [] : [{ key: 'app', label: t('connections.details.appId'), value: appId }]),
    ...(installationId === null ? [] : [{ key: 'installation', label: t('connections.details.installationId'), value: installationId }]),
  ]
  return (
    <>
      {ids.map((id) => (
        <CopyableId key={id.key} label={id.label} value={id.value} copied={copiedKey === id.key}
          onCopy={() => { onCopy(id.value, id.key) }} />
      ))}
    </>
  )
}

function Facts({ connection, issues, labelName }: Readonly<{
  connection: EngineeringConnection; issues: ConnectionIssues | undefined; labelName: string
}>) {
  const { t, i18n } = useTranslation('agents')
  const attestation = useAttestationText()
  const { credential } = connection
  const gitlab = connection.host === 'gitlab'
  const when = formatDateTime(connection.updated_at, i18n.language, '')
  const key = credential.set ? t('connections.details.keyStored') : t('connections.details.keyMissing')
  return (
    <>
      <Fact label={t('connections.details.branch')}>{connection.default_branch}</Fact>
      <Fact label={t('connections.details.host')}>
        {[t(`connections.hosts.${connection.host}`), gitlab ? t('connections.kindToken') : t('connections.kind')].join(' · ')}
      </Fact>
      <Fact label={t('connections.details.key')}>{key}</Fact>
      {gitlab && credential.expires_at !== null && (
        <Fact label={t('connections.details.tokenExpiry')}>{formatCalendarDay(credential.expires_at, i18n.language)}</Fact>
      )}
      <Fact label={t('connections.details.ci')}>{attestation(connection.ci_attestation)}</Fact>
      {issues?.label !== undefined && issues.label !== null && (
        <Fact label={t('connections.details.label')}>{t(`connections.issues.label.${issues.label}`, { label: labelName })}</Fact>
      )}
      {when !== '' && (
        <Fact label={t('connections.details.updated')}>
          {t('connections.updated', { when, who: connection.updated_by ?? t('connections.unknownEditor') })}
        </Fact>
      )}
    </>
  )
}

export function ConnectionDetails({ connection, issues, labelName }: Readonly<{
  connection: EngineeringConnection
  /** The GitHub Issues source's word on the connection (its label's state), when it names it. */
  issues: ConnectionIssues | undefined
  /** The label the source creates on each repository (`voc-agent`). */
  labelName: string
}>) {
  const { t } = useTranslation('agents')
  const { copy, copiedKey } = useCopyToClipboard()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const titleId = useId()
  const close = () => { setOpen(false) }
  useOverlayFocus(panelRef, open, { onClose: close, closeOnFocusOut: true, returnFocusTo: buttonRef })
  useCloseOnViewportChange(open, close, panelRef)
  useCloseOnPressOutside(open, close, panelRef, buttonRef)
  useLayoutEffect(() => {
    const panel = panelRef.current
    const button = buttonRef.current
    if (open && panel !== null && button !== null) placeFixedMenu(panel, button.getBoundingClientRect(), 'end')
  }, [open])
  const name = t('connections.details.button', { repository: connection.repository })
  return (
    <>
      <Tooltip kind="label" content={name}>
        <button ref={buttonRef} type="button" className="icon-btn" aria-label={name} aria-expanded={open}
          aria-controls={open ? panelId : undefined} onClick={() => { setOpen((current) => !current) }}>
          <Info size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {open && createPortal(
        <div ref={panelRef} id={panelId} role="dialog" aria-labelledby={titleId}
          className="menu fixed z-[75] w-72 max-w-[calc(100vw-1rem)] p-3" data-testid="connection-details">
          <p id={titleId} className="text-[12px] font-semibold text-text-strong">{t('connections.details.title')}</p>
          <p className="mb-1 text-[12px] text-muted break-all">{connection.repository}</p>
          <dl className="divide-y divide-border">
            <Ids connection={connection} copiedKey={copiedKey} onCopy={copy} />
            <Facts connection={connection} issues={issues} labelName={labelName} />
          </dl>
          <p role="status" className="sr-only">{copiedKey === null ? '' : t('connections.details.copied')}</p>
        </div>,
        document.body,
      )}
    </>
  )
}
