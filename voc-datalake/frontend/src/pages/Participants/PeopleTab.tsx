/**
 * @fileoverview Participants → People: everyone on any list, searchable (email, name,
 * company — the server matches) and narrowable to one list. A row opens the person.
 * @module pages/Participants/PeopleTab
 */
import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { ParticipantList, Person } from '../../api/participantsSchema'
import { PersonStatusBadge } from './ParticipantBadges'
import PersonModal from './PersonModal'

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted'
const TD = 'px-3 py-2 text-sm text-text align-top break-words'

/** The names of the lists a person is on, or null when the listing did not say. */
function listNames(person: Person, names: ReadonlyMap<string, string>): string | null {
  if (person.list_ids === undefined) return null
  return person.list_ids.flatMap((listId) => names.get(listId) ?? []).join(', ')
}

function PeopleTable({ people, lists, onOpen }: Readonly<{
  people: readonly Person[]; lists: readonly ParticipantList[]; onOpen: (personId: string) => void
}>) {
  const { t } = useTranslation('participants')
  const names = new Map(lists.map((list) => [list.list_id, list.name]))
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[40rem]">
        <thead className="bg-bg-accent border-b border-border">
          <tr>
            <th scope="col" className={TH}>{t('person.email')}</th>
            <th scope="col" className={TH}>{t('person.name')}</th>
            <th scope="col" className={TH}>{t('person.company')}</th>
            <th scope="col" className={TH}>{t('person.lists')}</th>
            <th scope="col" className={TH}>{t('person.status')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {people.map((person) => (
            <tr key={person.person_id}>
              <td className={TD}>
                <button type="button" onClick={() => onOpen(person.person_id)} className="link text-left break-all">
                  {person.email}
                </button>
              </td>
              <td className={TD}>{person.name}</td>
              <td className={TD}>{person.company}</td>
              <td className={TD}>{listNames(person, names) ?? '—'}</td>
              <td className={TD}><PersonStatusBadge status={person.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function PeopleTab() {
  const { t } = useTranslation('participants')
  const [query, setQuery] = useState('')
  const [listId, setListId] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const q = useDeferredValue(query.trim())
  const lists = useQuery({ queryKey: participantsKeys.lists(), queryFn: participantsApi.getLists })
  const people = useQuery({ queryKey: participantsKeys.people(q, listId), queryFn: () => participantsApi.getPeople(q, listId) })

  const body = () => {
    if (people.isPending) return <p role="status" className="text-sm text-muted">{t('loading')}</p>
    if (people.isError) return <LoadFailed onRetry={() => void people.refetch()} retrying={people.isFetching} message={t('people.loadFailed')} />
    if (people.data.length === 0) return <p className="card text-sm text-muted">{q === '' && listId === '' ? t('people.empty') : t('people.noMatch')}</p>
    return <PeopleTable people={people.data} lists={lists.data ?? []} onOpen={setOpenId} />
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">{t('people.search')}</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('people.searchPlaceholder')}
            className="input w-full pl-8" />
        </label>
        <label className="sm:w-64">
          <span className="sr-only">{t('people.filterList')}</span>
          <select value={listId} onChange={(e) => setListId(e.target.value)} className="select w-full">
            <option value="">{t('people.allLists')}</option>
            {(lists.data ?? []).map((list) => <option key={list.list_id} value={list.list_id}>{list.name}</option>)}
          </select>
        </label>
      </div>
      {body()}
      {openId === null ? null : <PersonModal personId={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}
