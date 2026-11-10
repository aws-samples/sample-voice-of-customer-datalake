/**
 * @fileoverview Find an existing person by email, name or company and pick them. Used by
 * the ask composer and by a project's "Add an existing person".
 * @module pages/Participants/PersonSearch
 */
import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { Person } from '../../api/participantsSchema'
import { displayName } from './personLabel'

const SEARCH_RESULTS_SHOWN = 8

export default function PersonSearch({ label, excludeIds, onPick }: Readonly<{
  label: string
  /** Already chosen: never offered again. */
  excludeIds: readonly string[]
  onPick: (person: Person) => void
}>) {
  const { t } = useTranslation('participants')
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query.trim())
  const results = useQuery({ queryKey: participantsKeys.people(q, ''), queryFn: () => participantsApi.getPeople(q), enabled: q !== '' })
  const matches = (results.data ?? []).filter((p) => !excludeIds.includes(p.person_id)).slice(0, SEARCH_RESULTS_SHOWN)
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-sm font-medium text-text mb-1">{label}</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('people.searchPlaceholder')} className="input w-full" />
      </label>
      {q !== '' && results.isSuccess && matches.length === 0 ? <p className="text-xs text-muted">{t('people.noMatch')}</p> : null}
      {matches.length === 0 ? null : (
        <ul className="rounded-md border border-border divide-y divide-border" aria-label={t('composer.searchResults')}>
          {matches.map((person) => (
            <li key={person.person_id}>
              <button type="button" onClick={() => { onPick(person); setQuery('') }}
                className="w-full text-left px-2 py-1.5 text-sm text-text hover:bg-bg-accent break-all">
                {displayName(person)} <span className="text-xs text-muted">{person.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
