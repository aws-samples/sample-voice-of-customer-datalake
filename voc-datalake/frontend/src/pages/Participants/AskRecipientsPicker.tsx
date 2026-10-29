/**
 * @fileoverview Who an ask goes to: lists (checkboxes) and/or people (search, then pick),
 * and how many distinct people that is. The chosen lists' members are read to count them;
 * unsubscribed people are skipped by the server at send time, which is said, not guessed.
 * @module pages/Participants/AskRecipientsPicker
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { Person } from '../../api/participantsSchema'
import { toggle } from './askDraft'
import { displayName } from './personLabel'
import PersonSearch from './PersonSearch'

function ListChoices({ listIds, onChange }: Readonly<{ listIds: readonly string[]; onChange: (ids: string[]) => void }>) {
  const { t } = useTranslation('participants')
  const lists = useQuery({ queryKey: participantsKeys.lists(), queryFn: participantsApi.getLists })
  const all = lists.data ?? []
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-text mb-1">{t('composer.lists')}</legend>
      {all.length === 0 ? <p className="text-xs text-muted">{t('composer.noLists')}</p> : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {all.map((list) => (
            <li key={list.list_id}>
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" checked={listIds.includes(list.list_id)} onChange={() => onChange(toggle(listIds, list.list_id))} className="mt-1" />
                <span className="break-words">{list.name} <span className="text-xs text-muted">({t('lists.memberCount', { count: list.member_count })})</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

/** The people picked one by one; pressing a chip removes that person. */
function PersonChips({ people, onRemove }: Readonly<{ people: readonly Pick<Person, 'person_id' | 'name' | 'email'>[]; onRemove: (id: string) => void }>) {
  const { t } = useTranslation('participants')
  return people.length === 0 ? null : (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('composer.people')}>
      {people.map((person) => (
        <button key={person.person_id} type="button" onClick={() => onRemove(person.person_id)}
          aria-label={t('composer.removePerson', { name: displayName(person) })}
          className="badge badge-muted inline-flex items-center gap-1 break-all text-left">
          {displayName(person)}
          <X size={12} aria-hidden className="shrink-0" />
        </button>
      ))}
    </div>
  )
}

function PeopleChoices({ personIds, known, onChange }: Readonly<{
  personIds: readonly string[]
  /** People the caller already knows (a project's linked people), shown by name before any search. */
  known: readonly Person[]
  onChange: (ids: string[], picked: Person | null) => void
}>) {
  const { t } = useTranslation('participants')
  const chosen = personIds.map((id) => known.find((p) => p.person_id === id) ?? { person_id: id, name: '', email: id })
  return (
    <div className="space-y-2">
      <PersonSearch label={t('composer.people')} excludeIds={personIds} onPick={(person) => onChange([...personIds, person.person_id], person)} />
      <PersonChips people={chosen} onRemove={(id) => onChange(personIds.filter((other) => other !== id), null)} />
    </div>
  )
}

export default function AskRecipientsPicker({ listIds, personIds, known, onLists, onPeople, recipientCount }: Readonly<{
  listIds: readonly string[]
  personIds: readonly string[]
  known: readonly Person[]
  onLists: (ids: string[]) => void
  onPeople: (ids: string[], picked: Person | null) => void
  recipientCount: number | null
}>) {
  const { t } = useTranslation('participants')
  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label={t('composer.recipients')}>
      <ListChoices listIds={listIds} onChange={onLists} />
      <PeopleChoices personIds={personIds} known={known} onChange={onPeople} />
      <p role="status" className="text-sm text-text">
        {recipientCount === null ? t('composer.counting') : t('composer.recipientCount', { count: recipientCount })}
        {' '}<span className="text-xs text-muted">{t('composer.unsubscribedSkipped')}</span>
      </p>
    </section>
  )
}
