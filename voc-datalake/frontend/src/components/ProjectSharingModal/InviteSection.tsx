/**
 * @fileoverview Debounced user search + role picker + Invite (managers only).
 *
 * The candidates endpoint rejects `"` and `\`, caps `q` at 64 characters and
 * requires at least 3, so the query is cleaned here and only sent once it is
 * long enough, rather than sent to fail. The minimum is announced as the
 * search box's description. It already excludes the
 * owner and existing members, so every row it returns is invitable.
 *
 * @module components/ProjectSharingModal/InviteSection
 */
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, Loader2, UserPlus } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import {
  CANDIDATE_QUERY_MAX_LENGTH, CANDIDATE_QUERY_MIN_LENGTH, CANDIDATE_SEARCH_DEBOUNCE_MS, MEMBER_ROLES, cleanCandidateQuery, isMemberRole, personLabel,
  roleLabelKey,
} from './sharingHelpers'
import { memberCandidatesKey } from './useProjectSharing'
import { useDebouncedValue } from './useDebouncedValue'
import type { ProjectMemberCandidate, ProjectMemberRole } from '../../api/projectTypes'

interface InviteSectionProps {
  readonly projectId: string
  readonly disabled: boolean
  readonly onInvite: (sub: string, role: ProjectMemberRole, onDone: () => void) => void
}

export default function InviteSection({
  projectId, disabled, onInvite,
}: InviteSectionProps) {
  const { t } = useTranslation('projects')
  const searchId = useId()
  const roleId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ProjectMemberCandidate | null>(null)
  const [role, setRole] = useState<ProjectMemberRole>('viewer')
  const q = cleanCandidateQuery(useDebouncedValue(query, CANDIDATE_SEARCH_DEBOUNCE_MS))

  const hasQuery = q.length >= CANDIDATE_QUERY_MIN_LENGTH
  const hintId = `${searchId}-hint`

  const candidates = useQuery({
    queryKey: memberCandidatesKey(projectId, q),
    queryFn: () => projectsApi.searchMemberCandidates(projectId, q),
    enabled: hasQuery,
  })

  const reset = () => {
    setQuery('')
    setSelected(null)
  }

  const results = hasQuery ? (candidates.data ?? []) : []
  const showNoResults = hasQuery && !candidates.isFetching && candidates.isSuccess && results.length === 0

  return (
    <section aria-labelledby={`${searchId}-heading`} className="space-y-2">
      <h3 id={`${searchId}-heading`} className="text-sm font-semibold tracking-tight text-text-strong">{t('sharing.inviteHeading')}</h3>
      <label htmlFor={searchId} className="block text-[13px] font-medium text-text">{t('sharing.searchLabel')}</label>
      <input
        id={searchId}
        type="search"
        value={query}
        maxLength={CANDIDATE_QUERY_MAX_LENGTH}
        onChange={(e) => {
          setQuery(e.target.value)
          setSelected(null)
        }}
        placeholder={t('sharing.searchPlaceholder')}
        aria-describedby={hintId}
        autoComplete="off"
        className="input"
      />
      <p id={hintId} className="text-xs text-muted">
        {t('sharing.searchMinLength', { min: CANDIDATE_QUERY_MIN_LENGTH })}
      </p>
      <div aria-live="polite" className="text-xs text-muted">
        {hasQuery && candidates.isFetching ? (
          <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('sharing.searching')}</span>
        ) : null}
        {showNoResults ? t('sharing.noResults') : null}
        {selected === null ? null : t('sharing.selected', { name: personLabel(selected) })}
      </div>
      {results.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {results.map((candidate) => {
            const isSelected = selected?.sub === candidate.sub
            return (
              <li key={candidate.sub}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={t('sharing.select', { name: personLabel(candidate) })}
                  onClick={() => setSelected(candidate)}
                  // Hover paints bg-bg-hover; the selected row keeps bg-accent-subtle even under the pointer.
                  className={clsx('w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors', isSelected ? 'bg-accent-subtle' : 'hover:bg-bg-hover')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-text-strong truncate">{personLabel(candidate)}</span>
                    {/* `text-muted` is only 4.05:1 on the dark `bg-accent-subtle` row, so the selected row's email uses `text-text`. */}
                    {candidate.email === '' ? null : <span className={clsx('block text-xs truncate', isSelected ? 'text-text' : 'text-muted')}>{candidate.email}</span>}
                  </span>
                  {isSelected ? <Check size={16} className="text-accent-text flex-shrink-0" aria-hidden="true" /> : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor={roleId} className="block text-[13px] font-medium text-text mb-1">{t('sharing.inviteRoleLabel')}</label>
          <select
            id={roleId}
            value={role}
            onChange={(e) => {
              if (isMemberRole(e.target.value)) setRole(e.target.value)
            }}
            className="select"
          >
            {MEMBER_ROLES.map((r) => <option key={r} value={r}>{t(roleLabelKey(r))}</option>)}
          </select>
        </div>
        <button
          type="button"
          disabled={disabled || selected === null}
          onClick={() => {
            if (selected !== null) onInvite(selected.sub, role, reset)
          }}
          className="btn btn-primary flex-shrink-0"
        >
          <UserPlus size={16} aria-hidden="true" />
          {t('sharing.invite')}
        </button>
      </div>
    </section>
  )
}
