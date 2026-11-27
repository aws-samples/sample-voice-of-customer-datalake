/**
 * @fileoverview The full pages of the workspace gate, each with Sign out:
 * - the picker (no `/workspace/{slug}` in the address and two or more workspaces) and "workspace not found" (a
 *   `/workspace/{slug}` the caller is not a member of). Both list the caller's own workspaces as plain links into
 *   `/workspace/{slug}/…` (the picker keeps the path asked for, so a link shared without a workspace still opens its
 *   page; not-found opens a workspace's start page): a full page load, so the router starts again under that
 *   base path. Neither page says whether a slug exists.
 * - "could not load your workspaces" (a `/workspace/…` address whose list could not be read), with Retry: such an
 *   address never opens the app without its workspace.
 *
 * The picker, and the not-found page of a caller with no workspace yet, offer Create a workspace (7.104.00) to whoever
 * the platform console is shown to (`seesPlatformConsole`, adminTabs.ts: an administrator in `platform-admins`;
 * `POST /platform/workspaces` checks the same groups again, live): the console's own form below the list, then a full
 * page load into the new workspace, which the caller administers (`enterWorkspace.ts`).
 *
 * @module workspace/WorkspaceChoice
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { Building2, LogOut, Plus, RotateCw } from 'lucide-react'
import clsx from 'clsx'
import { useSignOut } from '../hooks/useSignOut'
import { useIsAdmin, useIsPlatformAdmin } from '../store/authStore'
import CreateWorkspaceForm from '../pages/Settings/CreateWorkspaceForm'
import { seesPlatformConsole } from '../pages/Settings/adminTabs'
import { enterWorkspace } from './enterWorkspace'
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

/** Create a workspace: a secondary button under the list that shows the console's form; a create enters the new one. */
function CreateWorkspaceOffer() {
  const { t } = useTranslation()
  const formId = useId()
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-3">
      <button type="button" className="btn btn-secondary gap-2" aria-expanded={open} aria-controls={open ? formId : undefined}
        onClick={() => setOpen(!open)}>
        <Plus size={16} aria-hidden="true" />
        {t('workspaces.picker.create')}
      </button>
      {open ? <div id={formId}><CreateWorkspaceForm onCreated={(workspace) => enterWorkspace(workspace)} /></div> : null}
    </div>
  )
}

/** Whether the caller is one the platform console is shown to (adminTabs.ts). */
function useSeesPlatformConsole(): boolean {
  const isAdmin = useIsAdmin()
  const isPlatformAdmin = useIsPlatformAdmin()
  return seesPlatformConsole({ isAdmin, isPlatformAdmin })
}

function WorkspaceLinks({ workspaces, path, lastUsed }: Readonly<{ workspaces: readonly CurrentWorkspace[]; path: string; lastUsed: string | null }>) {
  const { t } = useTranslation()
  return (
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
  )
}

export default function WorkspaceChoice({ workspaces, path, notFound, refused }: WorkspaceChoiceProps) {
  const { t } = useTranslation()
  const lastUsed = notFound ? null : lastWorkspaceSlug()
  const none = workspaces.length === 0
  const start = notFound && none
    ? <a href="/" className="btn btn-primary">{t('workspaces.notFound.start')}</a>
    : null
  // The picker, or "You are not a member of any workspace yet" (not a workspace the server refused in this tab).
  const offersCreate = useSeesPlatformConsole() && (!notFound || (none && !refused))

  return (
    <GatePage
      title={notFound ? t('workspaces.notFound.title') : t('workspaces.picker.title')}
      body={notFound ? t('workspaces.notFound.body') : t('workspaces.picker.intro')}
      actions={start}
    >
      {none
        ? <p className="card text-sm text-text">{refused ? t('workspaces.notFound.notAvailable') : t('workspaces.notFound.none')}</p>
        : <WorkspaceLinks workspaces={workspaces} path={path} lastUsed={lastUsed} />}
      {offersCreate ? <CreateWorkspaceOffer /> : null}
    </GatePage>
  )
}

/** The list could not be read on a `/workspace/…` address: say so, and offer Retry (the list read again). */
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
