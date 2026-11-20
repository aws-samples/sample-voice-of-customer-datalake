/**
 * @fileoverview Agents → Connections, "Add a repository" (7.60.00): the three ways to connect a GitHub repository the
 * agents push to, side by side, each with when to use it and what a run ends with, so a person picks by what they can
 * do on the repository rather than by how it works:
 *
 * 1. **Install the GitHub App** (you administer the repository, or its organization lets you install apps): a branch
 *    and a pull request on the repository. Its action is the deployment's App's install link (Add repositories), or,
 *    with no App yet, Create the App on GitHub.
 * 2. **Use a fine-grained token** (a public repository you can push to but cannot install the App on): a branch and a
 *    pull request on the repository, pushed with your token after your go (TokenConnectionDialog.tsx). It needs the
 *    deployment's App installed somewhere: its read-only token reads the repository.
 * 3. **Contribute through a fork** (someone else's public repository): a pull request on your fork, then a one-click
 *    link to open it on the repository (7.57.00's Contribute card). Its action takes the person to the public
 *    repositories' search, where it starts.
 *
 * Every button here is secondary: the page's one primary is the hero's while nothing is connected (this section shows
 * once something is), and none after. The other ways (another App, a pasted key, GitLab) stay folded under it
 * (MoreWaysToConnect.tsx).
 *
 * @module pages/Agents/AddRepositoryChooser
 */
import { useId } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitFork, KeyRound, Loader2, PackagePlus } from 'lucide-react'
import { githubAppsApi } from '../../api/githubAppsApi'
import { CreateApp } from './GitHubAppPanel'
import { useConnectionError } from './connectionText'
import { leavingForGitHub } from './githubReturn'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { GitHubApp } from '../../api/githubAppsApi'

/** One way: its title, when to use it, what the run ends with, and its action. */
function WayCard({ id, icon: Icon, title, when, ends, children }: Readonly<{
  id: string; icon: LucideIcon; title: string; when: string; ends: string; children: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  return (
    <li className="card flex flex-col gap-3 p-4" aria-labelledby={titleId} data-testid={`add-way-${id}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted">
          <Icon size={16} aria-hidden="true" />
        </span>
        <h4 id={titleId} className="text-sm font-semibold text-text-strong">{title}</h4>
      </div>
      <dl className="space-y-2 text-[12px]">
        <div>
          <dt className="font-medium text-muted">{t('connections.add.useWhen')}</dt>
          <dd className="text-text">{when}</dd>
        </div>
        <div>
          <dt className="font-medium text-muted">{t('connections.add.endsWith')}</dt>
          <dd className="text-text">{ends}</dd>
        </div>
      </dl>
      <div className="mt-auto space-y-1">{children}</div>
    </li>
  )
}

/** The App's install link (in this tab), to add the repository to its installation. */
function AddToApp({ app }: Readonly<{ app: GitHubApp }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const install = useMutation({
    mutationFn: () => githubAppsApi.install(app.app_id),
    onSuccess: ({ installUrl }) => { leavingForGitHub(); window.location.assign(installUrl) },
  })
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-disabled={install.isPending || undefined}
        onClick={() => { if (!install.isPending) install.mutate() }}>
        {install.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {t('connections.add.app.action', { slug: app.slug })}
      </button>
      {install.isError && <p role="alert" className="text-[12px] text-danger">{errorText(install.error)}</p>}
    </>
  )
}

/** A way's action, held (with why) until the deployment's App can read the repository. */
function HeldAction({ label, held, heldText, onClick }: Readonly<{
  label: string; held: boolean; heldText: string; onClick: () => void
}>) {
  const hintId = useId()
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-disabled={held || undefined}
        aria-describedby={held ? hintId : undefined} onClick={() => { if (!held) onClick() }}>
        {label}
      </button>
      {held && <p id={hintId} className="text-[12px] text-muted">{heldText}</p>}
    </>
  )
}

export function AddRepositoryChooser({ apps, appsFull, connectionsFull, onToken, onFork }: Readonly<{
  /** The deployment's GitHub Apps, as read (none: not read, or none made). */
  apps: readonly GitHubApp[]
  /** The deployment holds its most Apps: Create the App waits. */
  appsFull: boolean
  /** The deployment holds its most connections: a token connection waits. */
  connectionsFull: boolean
  /** Open the token dialog. */
  onToken: () => void
  /** Go to the public repositories' search (the fork starts there). */
  onFork: () => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const installed = apps.find((app) => app.connections.length > 0) ?? null
  const first = installed ?? apps[0] ?? null
  return (
    <section className="space-y-2" aria-labelledby={titleId} data-testid="add-repository">
      <div>
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('connections.add.title')}</h3>
        <p className="text-[12px] text-muted">{t('connections.add.intro')}</p>
      </div>
      <ul className="grid gap-3 md:grid-cols-3" aria-labelledby={titleId}>
        <WayCard id="app" icon={PackagePlus} title={t('connections.add.app.title')} when={t('connections.add.app.when')}
          ends={t('connections.add.app.ends')}>
          {first === null ? <CreateApp full={appsFull} emphasis="secondary" /> : <AddToApp app={first} />}
        </WayCard>
        <WayCard id="token" icon={KeyRound} title={t('connections.add.token.title')} when={t('connections.add.token.when')}
          ends={t('connections.add.token.ends')}>
          <HeldAction label={t('connections.add.token.action')} held={installed === null || connectionsFull}
            heldText={connectionsFull ? t('connections.public.full') : t('connections.add.needsApp')} onClick={onToken} />
        </WayCard>
        <WayCard id="fork" icon={GitFork} title={t('connections.add.fork.title')} when={t('connections.add.fork.when')}
          ends={t('connections.add.fork.ends')}>
          <HeldAction label={t('connections.add.fork.action')} held={apps.length === 0} heldText={t('connections.add.needsApp')}
            onClick={onFork} />
        </WayCard>
      </ul>
    </section>
  )
}
