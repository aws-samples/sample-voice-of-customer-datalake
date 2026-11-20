/**
 * @fileoverview Any public GitHub repository on Agents → Connections (7.57.00).
 *
 * - **Add a public repository** ({@link PublicRepositoryPicker}, once the deployment has a GitHub App to read with): one
 *   search box (a name, `owner/name` or a GitHub address), searched on the server (`GET
 *   /agents/engineering/public-repositories`); each result with its stars, its licence (SPDX), an Archived badge and
 *   its last push, and **Connect read-only** (`POST /agents/engineering/public-connections`; a repository already
 *   connected says so). Read-only means: its issues are read as feedback, Understand and the knowledge docs stay in VoC,
 *   triage and bug hunts stay in VoC, and nothing is written to GitHub (no label, comment or pull request). A private
 *   repository connects through the App's installation, as before.
 * - **Public repositories (read-only)** ({@link PublicConnections}): one row each, its kind badge, its facts, its issues
 *   switch (the deployment's GitHub Issues source reads it as for any connection), the "stays in VoC" note, its "⋯"
 *   (Remove connection…) and the guided setup of contributing to it (ContributeCard.tsx: fork it, let the agents push to
 *   the fork; each run's upstream pull request is one click away). No CI to attest: the agents push nothing to it.
 *
 * @module pages/Agents/PublicRepositories
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Archive, ExternalLink, Eye, FolderGit2, Loader2, Scale, Search, Star, Trash2 } from 'lucide-react'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { RowActionsMenu } from '../../components/RowActionsMenu/RowActionsMenu'
import { engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { issuesSourceKeys } from '../../api/issuesSourceApi'
import { MAX_QUERY_CHARS, publicRepositoriesApi, publicRepositoriesKeys } from '../../api/publicRepositoriesApi'
import { refusalReason } from '../../lib/errors'
import { formatRelativeDate } from '../../utils/dateUtils'
import { IssuesCell, IssuesFollowLines } from './ConnectionIssues'
import { ContributeCard } from './ContributeCard'
import { ContributeDialog } from './ContributeDialog'
import { useConnectionError } from './connectionText'
import type { ReactNode, RefObject } from 'react'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { GitHubApp } from '../../api/githubAppsApi'
import type { IssuesSourceView } from '../../api/issuesSourceApi'
import type { PublicRepository } from '../../api/publicRepositoriesApi'

/** A refusal in the server's words when it gave one (400, 404, 409), else the connections' sentence for its status. */
function usePublicError(): (error: unknown) => string {
  const connectionError = useConnectionError()
  return (error) => refusalReason(error) ?? connectionError(error)
}

/** A repository's stars, licence, archived state and last push, as badges and plain text. */
function RepositoryFacts({ stars, licence, archived, pushedAt }: Readonly<{
  stars: number; licence: string | null; archived: boolean; pushedAt: string | null
}>) {
  const { t, i18n } = useTranslation('agents')
  const pushed = formatRelativeDate(pushedAt, i18n.language)
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted tabular-nums">
      <span className="inline-flex items-center gap-1"><Star size={12} aria-hidden="true" />{t('connections.public.stars', { count: stars })}</span>
      <span className="inline-flex items-center gap-1">
        <Scale size={12} aria-hidden="true" />{licence === null ? t('connections.public.noLicence') : t('connections.public.licence', { licence })}
      </span>
      {pushed !== '' && <span>{t('connections.public.pushed', { when: pushed })}</span>}
      {archived && <IconBadge toneClass="badge-warn" icon={Archive}>{t('connections.public.archived')}</IconBadge>}
    </p>
  )
}

/** One search result: its name (its page on GitHub), what it is, its facts, and Connect read-only. */
function ResultRow({ repository, busy, onConnect }: Readonly<{
  repository: PublicRepository; busy: boolean; onConnect: () => void
}>) {
  const { t } = useTranslation('agents')
  const connected = repository.connected !== null
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid={`public-result-${repository.repository}`}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">
          {repository.html_url === '' ? repository.repository : (
            <a className="link inline-flex items-center gap-1" href={repository.html_url} target="_blank" rel="noopener noreferrer">
              {repository.repository}<ExternalLink size={12} aria-hidden="true" />
              <span className="sr-only">{t('readiness.opensNewTab')}</span>
            </a>
          )}
        </p>
        {repository.description !== null && <p className="text-[12px] text-text break-words [overflow-wrap:anywhere]">{repository.description}</p>}
        <RepositoryFacts stars={repository.stars} licence={repository.licence?.spdx ?? null} archived={repository.archived}
          pushedAt={repository.pushed_at} />
      </div>
      {connected ? <span className="text-[12px] text-ok">{t('connections.public.connected')}</span> : (
        <button type="button" className="btn btn-secondary btn-sm" aria-label={`${t('connections.public.connect')} ${repository.repository}`}
          aria-disabled={busy || undefined} onClick={() => { if (!busy) onConnect() }}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('connections.public.connect')}
        </button>
      )}
    </li>
  )
}

/**
 * A public search's outcome (`GET …/public-repositories`): searching, its failure (the server's reason when it gave
 * one) or that nothing was found, else `children` with what was found; `inset`: inside the picker's card (its padding).
 * The picker's, and (7.60.00) the token dialog's (TokenConnectionParts.tsx).
 */
export function PublicSearchOutcome({ query, inset, children }: Readonly<{
  query: string; inset: boolean; children: (repositories: readonly PublicRepository[]) => ReactNode
}>) {
  const { t } = useTranslation('agents')
  const errorText = usePublicError()
  const search = useQuery({
    queryKey: publicRepositoriesKeys.search(query), queryFn: () => publicRepositoriesApi.search(query), retry: false,
  })
  const pad = inset ? 'px-4 pb-3 ' : ''
  if (search.isPending) {
    return (
      <p role="status" className={`${pad}flex items-center gap-2 text-[12px] text-muted`}>
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('connections.public.searching')}
      </p>
    )
  }
  if (search.isError) return <p role="alert" className={`${pad}text-[12px] text-danger`}>{errorText(search.error)}</p>
  if (search.data.repositories.length === 0) {
    return <p role="status" className={`${pad}text-[12px] text-muted`}>{t('connections.public.none', { query })}</p>
  }
  return <>{children(search.data.repositories)}</>
}

/** The search's results, its failure, or that nothing was found. */
function Results({ query, connecting, onConnect }: Readonly<{
  query: string; connecting: string | null; onConnect: (repository: string) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <PublicSearchOutcome query={query} inset>
      {(repositories) => (
        <ul role="list" aria-label={t('connections.public.resultsLabel')} className="divide-y divide-border border-t border-border">
          {repositories.map((repository) => (
            <ResultRow key={repository.repository} repository={repository} busy={connecting === repository.repository}
              onConnect={() => { onConnect(repository.repository) }} />
          ))}
        </ul>
      )}
    </PublicSearchOutcome>
  )
}

/** Add a public repository: search, then Connect read-only; `searchRef`: its search box (7.60.00: the chooser's
 *  Contribute through a fork brings the person there). */
export function PublicRepositoryPicker({ full, onNotice, searchRef }: Readonly<{
  full: boolean; onNotice: (text: string) => void; searchRef?: RefObject<HTMLInputElement | null>
}>) {
  const { t } = useTranslation('agents')
  const errorText = usePublicError()
  const queryClient = useQueryClient()
  const titleId = useId()
  const inputId = useId()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const connect = useMutation({
    mutationFn: (repository: string) => publicRepositoriesApi.connect(repository),
    onSuccess: ({ connection }) => {
      void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: issuesSourceKeys.view() })
      void queryClient.invalidateQueries({ queryKey: publicRepositoriesKeys.search(query) })
      onNotice(t('connections.public.connectedNotice', { repository: connection.repository }))
    },
  })
  return (
    <section className="card p-0 overflow-hidden" aria-labelledby={titleId} data-testid="public-repositories-picker">
      <div className="space-y-2 px-4 py-3">
        <h3 id={titleId} className="text-sm font-semibold text-text-strong">{t('connections.public.title')}</h3>
        <p className="max-w-prose text-[12px] text-muted">{t('connections.public.intro')}</p>
        <form role="search" className="flex flex-wrap items-end gap-2" noValidate onSubmit={(event) => {
          event.preventDefault()
          setQuery(text.trim())
        }}>
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={inputId} className="block text-sm font-medium text-text">{t('connections.public.searchLabel')}</label>
            <input ref={searchRef} id={inputId} type="search" className="input" value={text} maxLength={MAX_QUERY_CHARS} autoComplete="off"
              spellCheck={false} placeholder={t('connections.public.searchPlaceholder')} onChange={(event) => { setText(event.target.value) }} />
          </div>
          <button type="submit" className="btn btn-secondary btn-sm" aria-disabled={text.trim() === '' || undefined}>
            <Search size={14} aria-hidden="true" />{t('connections.public.search')}
          </button>
        </form>
        {full && <p className="text-[12px] text-warn">{t('connections.public.full')}</p>}
        {connect.isError && <p role="alert" className="text-[12px] text-danger">{errorText(connect.error)}</p>}
        {/* (what followed for the deployment's GitHub Issues source: its issues read as feedback) */}
        {connect.data !== undefined && <IssuesFollowLines follow={connect.data.issues} />}
      </div>
      {query !== '' && (
        <Results query={query} connecting={connect.isPending ? connect.variables : null}
          onConnect={(repository) => { if (!full) connect.mutate(repository) }} />
      )}
    </section>
  )
}

/** One public repository read only: its facts, issues, the note, its "⋯" and the guided setup of contributing to it. */
function PublicConnectionRow({ connection, view, children, onRemove }: Readonly<{
  connection: EngineeringConnection
  view: IssuesSourceView | undefined
  /** The guided setup of contributing to it (ContributeCard.tsx). */
  children: ReactNode
  onRemove: () => void
}>) {
  const { t } = useTranslation('agents')
  const facts = connection.public
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid={`public-row-${connection.connection_id}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted">
        <FolderGit2 size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">
          {connection.repository}
          <IconBadge toneClass="badge-muted" icon={Eye}>{t('connections.public.badge')}</IconBadge>
        </p>
        {facts !== null && <RepositoryFacts stars={facts.stars} licence={facts.licence} archived={facts.archived} pushedAt={facts.pushed_at} />}
        <p className="text-[12px] text-text">{t('connections.public.staysInVoc')}</p>
        <IssuesCell connection={connection} view={view} />
        {children}
      </div>
      <RowActionsMenu label={t('connections.menu.label', { repository: connection.repository })} entries={[{
        kind: 'action', id: 'remove', icon: Trash2, danger: true, label: t('connections.menu.remove'), onSelect: onRemove,
      }]} />
    </li>
  )
}

/** The public repositories read only, in a card of their own. */
export function PublicConnections({ connections, all, apps, view, onRemove }: Readonly<{
  connections: readonly EngineeringConnection[]
  /** Every stored connection (each public repository's fork among them). */
  all: readonly EngineeringConnection[]
  apps: readonly GitHubApp[]
  view: IssuesSourceView | undefined
  onRemove: (connection: EngineeringConnection) => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const [contributing, setContributing] = useState<EngineeringConnection | null>(null)
  return (
    <section className="card p-0 overflow-hidden" aria-labelledby={titleId} data-testid="public-connections">
      <div className="px-4 py-3">
        <h3 id={titleId} className="text-sm font-semibold text-text-strong">{t('connections.public.listTitle')}</h3>
        <p className="text-[12px] text-muted">{t('connections.public.listHint')}</p>
      </div>
      <ul role="list" aria-label={t('connections.public.listTitle')} className="divide-y divide-border border-t border-border">
        {connections.map((connection) => (
          <PublicConnectionRow key={connection.connection_id} connection={connection} view={view}
            onRemove={() => { onRemove(connection) }}>
            <ContributeCard connection={connection} connections={all}
              onInstall={() => { setContributing(connection) }} />
          </PublicConnectionRow>
        ))}
      </ul>
      {contributing !== null && <ContributeDialog connection={contributing} apps={apps} onClose={() => { setContributing(null) }} />}
    </section>
  )
}
