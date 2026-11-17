/**
 * @fileoverview Agents → Connections, "More ways to connect" (7.52.00, ux-agents-redesign part 1 §2.6): the ways to
 * add a connection besides the one in use, each folded under its title and a one-line hint, so a connected page does
 * not look unconnected (C1) and its header's action is never the hardest path (C2):
 *
 * - **Add another GitHub App** (once something is connected; while nothing is, the page's hero offers it): the
 *   account choice and Create the App on GitHub, a secondary button here;
 * - **Connect manually (advanced)**: what a pasted GitHub App's credential needs, and Add a GitHub connection;
 * - **GitLab**: what a GitLab project access token needs, and Add a GitLab connection.
 *
 * Each disclosure is a button with `aria-expanded` over its region (components/CollapsibleSection's pattern), whose
 * content mounts only while open; all start folded. The help text sits in its `bg-bg-accent` box (ConnectionFields.tsx
 * `CredentialGuidance`), never a static `bg-bg-hover` box above the list (C7).
 *
 * @module pages/Agents/MoreWaysToConnect
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Plus } from 'lucide-react'
import clsx from 'clsx'
import { CredentialGuidance } from './ConnectionFields'
import { CreateApp } from './GitHubAppPanel'
import type { ReactNode } from 'react'
import type { ConnectionHost } from '../../api/engineeringConnectionsApi'

function Way({ title, hint, children }: Readonly<{ title: string; hint: string; children: ReactNode }>) {
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const titleId = useId()
  const hintId = useId()
  return (
    <li className="px-4 py-3">
      {/* (named by its title, the hint its description) */}
      <button type="button" aria-expanded={open} aria-controls={regionId} aria-labelledby={titleId} aria-describedby={hintId}
        className="flex w-full items-start gap-2 rounded-md text-left focus-ring" onClick={() => { setOpen((current) => !current) }}>
        <ChevronRight size={16} aria-hidden="true"
          className={clsx('mt-0.5 shrink-0 text-muted transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="min-w-0 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-3">
          <span id={titleId} className="block text-sm font-medium text-text-strong">{title}</span>
          <span id={hintId} className="block text-[12px] text-muted">{hint}</span>
        </span>
      </button>
      <div id={regionId} role="region" aria-label={title} hidden={!open} className="mt-3 space-y-3 ps-6">
        {open && children}
      </div>
    </li>
  )
}

/** A way's Add button: the connection dialog on `host`, waiting at the connection limit (said under the list). */
function AddButton({ label, full, onClick }: Readonly<{ label: string; full: boolean; onClick: () => void }>) {
  return (
    <button type="button" className="btn btn-secondary btn-sm" disabled={full} onClick={onClick}>
      <Plus size={14} aria-hidden="true" /> {label}
    </button>
  )
}

export function MoreWaysToConnect({ anotherApp, appsFull, appLimit, connectionsFull, connectionLimit, onAdd }: Readonly<{
  /** Offer another GitHub App (something is connected already; the hero offers the first). */
  anotherApp: boolean
  /** The deployment holds its most Apps, or their list is not read: Create the App waits. */
  appsFull: boolean
  /** The most Apps, when the list said; null when not read. */
  appLimit: number | null
  /** The deployment holds its most connections: Add waits. */
  connectionsFull: boolean
  connectionLimit: number
  /** Open the connection dialog for a new connection on `host`. */
  onAdd: (host: ConnectionHost) => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  return (
    <section className="space-y-2" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('connections.more.title')}</h3>
      <ul className="card p-0 divide-y divide-border" aria-labelledby={titleId}>
        {anotherApp && (
          <Way title={t('connections.more.anotherApp')} hint={t('connections.more.anotherAppHint')}>
            <CreateApp full={appsFull} emphasis="secondary" />
            {appsFull && appLimit !== null && (
              <p className="text-[12px] text-muted">{t('connections.githubApp.limitReached', { limit: appLimit })}</p>
            )}
          </Way>
        )}
        <Way title={t('connections.more.manual')} hint={t('connections.more.manualHint')}>
          <CredentialGuidance host="github" />
          <AddButton label={t('connections.more.addGithub')} full={connectionsFull} onClick={() => { onAdd('github') }} />
        </Way>
        <Way title={t('connections.more.gitlab')} hint={t('connections.more.gitlabHint')}>
          <CredentialGuidance host="gitlab" />
          <AddButton label={t('connections.more.addGitlab')} full={connectionsFull} onClick={() => { onAdd('gitlab') }} />
        </Way>
      </ul>
      {connectionsFull && <p className="text-[12px] text-muted">{t('connections.limitReached', { limit: connectionLimit })}</p>}
    </section>
  )
}
