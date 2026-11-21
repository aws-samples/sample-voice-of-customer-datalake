/**
 * @fileoverview The token dialog's parts (TokenConnectionDialog.tsx, 7.60.00):
 *
 * - **The repository** ({@link RepositoryPick}): `owner/name` or its github.com address, or found on GitHub (the public
 *   repositories' search, `GET /agents/engineering/public-repositories`) and picked; a repository its `ways` say takes
 *   no token (archived) is shown and not offered.
 * - **The steps on GitHub** ({@link TokenSteps}): the resource owner, Only select repositories → the repository,
 *   Contents and Pull requests both Read and write, an expiry of 90 days or less, and GitHub's new-token page in a new
 *   tab, prefilled with what its link takes (tokenConnectionRules.ts `newTokenUrl`): the person picks the repository
 *   there, which no link can do.
 * - **The token** ({@link TokenField}): a password field, never offered to the browser's form filling, never shown
 *   again; and **the tick** ({@link OnlyThisRepository}) "This token can reach only ‹repo›", which the save needs.
 *
 * @module pages/Agents/TokenConnectionParts
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Search } from 'lucide-react'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { MAX_QUERY_CHARS } from '../../api/publicRepositoriesApi'
import { MAX_TOKEN_DAYS, newTokenUrl } from './tokenConnectionRules'
import { PublicSearchOutcome } from './PublicRepositories'
import type { PublicRepository } from '../../api/publicRepositoriesApi'

/** One search result: its name, and Use it (or why it takes no token). */
function Found({ repository, onPick }: Readonly<{ repository: PublicRepository; onPick: (name: string) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="min-w-0 font-mono text-[12px] text-text-strong break-all">{repository.repository}</span>
      {/* (a fine-grained token pushes to any public repository the search finds but an archived one) */}
      {!repository.archived ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { onPick(repository.repository) }}>
          {t('connections.token.repository.use', { repository: repository.repository })}
        </button>
      ) : <span className="text-[12px] text-muted">{t('connections.token.repository.noToken')}</span>}
    </li>
  )
}

/** The search's results (or its failure, or that nothing was found). */
function SearchResults({ query, onPick }: Readonly<{ query: string; onPick: (name: string) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <PublicSearchOutcome query={query} inset={false}>
      {(repositories) => (
        <ul role="list" aria-label={t('connections.public.resultsLabel')} className="divide-y divide-border">
          {repositories.map((repository) => <Found key={repository.repository} repository={repository} onPick={onPick} />)}
        </ul>
      )}
    </PublicSearchOutcome>
  )
}

/** The repository: typed, or found on GitHub and picked. */
export function RepositoryPick({ value, issue, onChange }: Readonly<{
  value: string
  /** What is wrong with it, already translated; null for nothing. */
  issue: string | null
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('agents')
  const [query, setQuery] = useState('')
  const find = () => { setQuery(value.trim()) }
  return (
    <div className="space-y-2">
      <LabeledField label={t('connections.token.repository.label')} hint={issue ?? t('connections.token.repository.hint')}
        hintTone={issue === null ? 'muted' : 'danger'}>
        {(id) => (
          <div className="flex flex-wrap items-center gap-2">
            <input id={id} type="text" className="input min-w-0 flex-1 font-mono" value={value} maxLength={MAX_QUERY_CHARS}
              autoComplete="off" spellCheck={false} aria-invalid={issue !== null} aria-describedby={`${id}-hint`}
              onChange={(event) => { onChange(event.target.value) }} />
            <button type="button" className="btn btn-secondary btn-sm" aria-disabled={value.trim() === '' || undefined}
              onClick={() => { if (value.trim() !== '') find() }}>
              <Search size={14} aria-hidden="true" />{t('connections.token.repository.find')}
            </button>
          </div>
        )}
      </LabeledField>
      {query !== '' && <SearchResults query={query} onPick={(name) => { onChange(name); setQuery('') }} />}
    </div>
  )
}

/** What to make on GitHub for `repository`, and GitHub's new-token page, prefilled. */
export function TokenSteps({ repository }: Readonly<{ repository: string }>) {
  const { t } = useTranslation('agents')
  const owner = repository.split('/')[0] ?? ''
  const steps = [
    t('connections.token.steps.owner', { owner }),
    t('connections.token.steps.access', { repository }),
    t('connections.token.steps.permissions'),
    t('connections.token.steps.expiry', { days: MAX_TOKEN_DAYS }),
  ]
  return (
    <section className="space-y-2 rounded-md border border-border bg-bg-accent px-3 py-2 text-[12px] text-text"
      aria-label={t('connections.token.steps.title')} data-testid="token-steps">
      <h3 className="font-medium text-text-strong">{t('connections.token.steps.title')}</h3>
      <ol className="list-decimal space-y-1 ps-5">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <p>{t('connections.token.steps.approval', { owner })}</p>
      <a className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" href={newTokenUrl(repository)} target="_blank"
        rel="noopener noreferrer" aria-label={t('engineeringRun.links.opens', { label: t('connections.token.steps.link') })}>
        {t('connections.token.steps.link')}<ExternalLink size={12} aria-hidden="true" />
      </a>
      <p className="text-muted">{t('connections.token.steps.prefilled')}</p>
    </section>
  )
}

/** The token: pasted, sent once, never shown again. */
export function TokenField({ value, issue, onChange }: Readonly<{
  value: string; issue: string | null; onChange: (value: string) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <LabeledField label={t('connections.token.field.label')} hint={issue ?? t('connections.token.field.hint')}
      hintTone={issue === null ? 'muted' : 'danger'}>
      {(id) => (
        <input id={id} type="password" className="input w-full font-mono" value={value} autoComplete="off"
          spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={issue !== null} aria-describedby={`${id}-hint`}
          onChange={(event) => { onChange(event.target.value) }} />
      )}
    </LabeledField>
  )
}

/** "This token can reach only ‹repo›": the person's word, which the save needs. */
export function OnlyThisRepository({ repository, checked, missing, onChange }: Readonly<{
  repository: string; checked: boolean
  /** The save was asked without it. */
  missing: boolean
  onChange: (checked: boolean) => void
}>) {
  const { t } = useTranslation('agents')
  const hintId = useId()
  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2 text-sm text-text">
        <input type="checkbox" className="mt-1" checked={checked} aria-invalid={missing} aria-describedby={hintId}
          onChange={(event) => { onChange(event.target.checked) }} />
        {t('connections.token.tick', { repository })}
      </label>
      <p id={hintId} className={missing ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
        {missing ? t('connections.token.tickRequired', { repository }) : t('connections.token.tickHint')}
      </p>
    </div>
  )
}
