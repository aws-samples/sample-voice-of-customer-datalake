/**
 * @fileoverview The full pages of the workspace gate, each with Sign out:
 * - the picker (no `/w/{slug}` in the address and two or more workspaces) and "workspace not found" (a
 *   `/w/{slug}` the caller is not a member of). Both list the caller's own workspaces as plain links into
 *   `/w/{slug}/…` (the picker keeps the path asked for, so a link shared without a workspace still opens its
 *   page; not-found opens a workspace's start page): a full page load, so the router starts again under that
 *   base path. Neither page says whether a slug exists.
 * - "could not load your workspaces" (a `/w/…` address whose list could not be read), with Retry: such an
 *   address never opens the app without its workspace.
 *
 * @module workspace/WorkspaceChoice
 */
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { Building2, LogOut, RotateCw } from 'lucide-react'
import clsx from 'clsx'
import { useSignOut } from '../hooks/useSignOut'
import { lastWorkspaceSlug } from './useMyWorkspaces'
import { workspaceUrl } from './workspacePath'
import type { CurrentWorkspace } from './currentWorkspace'

/** The pages' shell: a title, a line of explanation, the page's own content, then its actions and Sign out. */
function GatePage({ title, body, children, actions }: Readonly<{ title: string; body: string; children?: ReactNode; actions?: ReactNode }>) {
  const { t } = useTranslation()
  const signOut = useSignOut()
  return (
    <main className="min-h-screen bg-bg text-text px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-lg space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-text-strong">{title}</h1>
          <p className="text-sm text-muted">{body}</p>
        </div>
        {children}
        <div className="flex flex-wrap gap-3">
          {actions}
          <button type="button" className="btn btn-secondary gap-2" onClick={() => signOut()}>
            <LogOut size={16} aria-hidden="true" />
            {t('profileMenu.signOut')}
          </button>
        </div>
      </div>
    </main>
  )
}

interface WorkspaceChoiceProps {
  readonly workspaces: readonly CurrentWorkspace[]
  /** The app path each link opens inside its workspace (`/` for its start page). */
  readonly path: string
  /** The address named a workspace the caller cannot enter. */
  readonly notFound: boolean
  /**
   * The server refused a workspace of the caller's list in this tab: with none left, say that workspace is not
   * available (the caller may well have one), and the start page opens the app without a workspace.
   */
  readonly refused: boolean
}

export default function WorkspaceChoice({ workspaces, path, notFound, refused }: WorkspaceChoiceProps) {
  const { t } = useTranslation()
  const lastUsed = notFound ? null : lastWorkspaceSlug()
  const start = notFound && workspaces.length === 0
    ? <a href="/" className="btn btn-primary">{t('workspaces.notFound.start')}</a>
    : null

  return (
    <GatePage
      title={notFound ? t('workspaces.notFound.title') : t('workspaces.picker.title')}
      body={notFound ? t('workspaces.notFound.body') : t('workspaces.picker.intro')}
      actions={start}
    >
      {workspaces.length === 0 ? (
        <p className="card text-sm text-text">{refused ? t('workspaces.notFound.notAvailable') : t('workspaces.notFound.none')}</p>
      ) : (
        <nav aria-label={t('workspaces.listLabel')}>
          <ul className="space-y-2">
            {workspaces.map((workspace) => {
              const isLast = workspace.slug === lastUsed
              return (
                <li key={workspace.id}>
                  <a
                    href={workspaceUrl(workspace.slug, path)}
                    className={clsx('card focus-ring flex items-center gap-3 hover:border-border-strong', isLast && 'border-accent')}
                  >
                    <Building2 size={18} className="text-accent flex-shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-sm font-semibold text-text-strong break-words">{workspace.name}</span>
                    {isLast ? <span className="badge badge-accent">{t('workspaces.picker.lastUsed')}</span> : null}
                    <span className="badge badge-muted">{t(`workspaces.role.${workspace.role}`)}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>
      )}
    </GatePage>
  )
}

/** The list could not be read on a `/w/…` address: say so, and offer Retry (the list read again). */
export function WorkspaceUnavailable({ onRetry, retrying }: Readonly<{ onRetry: () => void; retrying: boolean }>) {
  const { t } = useTranslation()
  return (
    <GatePage
      title={t('workspaces.unavailable.title')}
      body={t('workspaces.unavailable.body')}
      actions={(
        <button type="button" className="btn btn-primary gap-2" onClick={() => onRetry()} disabled={retrying}>
          <RotateCw size={16} className={clsx(retrying && 'animate-spin')} aria-hidden="true" />
          {t('workspaces.unavailable.retry')}
        </button>
      )}
    />
  )
}
