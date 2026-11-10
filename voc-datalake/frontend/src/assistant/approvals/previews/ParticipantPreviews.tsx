/**
 * @fileoverview Approval previews of the `participants` pack writes
 * (docs/participants.md). Deterministic: every cell comes from the validated
 * args and the stored lists — no model-written prose.
 *
 * - add_participants: the list (its stored name, read fresh), how many people,
 *   then EVERY row (email, name, company, title, tags) in a scrollable table —
 *   the rows usually come from a pasted or attached list, and a row the
 *   approver cannot see is a row nobody reviewed. Repeats of one address are
 *   collapsed to their first row and counted in a note.
 * - create_participant_list: name, kind and description.
 *
 * @module assistant/approvals/previews/ParticipantPreviews
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { participantsApi, participantsKeys } from '../../../api/participantsApi'
import type { ParticipantList } from '../../../api/participantsSchema'
import { kindLabel } from '../../../pages/Participants/kindLabel'
import { uniquePeople } from '../participantSchemas'
import { Cell, TableHead } from './BulkAdminPreviews'
import { CardNote, FieldTable, NothingSavedNote } from './FieldDiff'
import { Code, Muted } from './ScraperValues'
import { fieldRow } from './format'
import type { AddParticipantsArgs, CreateParticipantListArgs, ParticipantPerson } from '../participantSchemas'

const P = 'preview.participants'

/**
 * GET /participants/lists, read fresh for the card (a card-local key). The Participants page's
 * cached lists stand in while it loads, so the card names the list at once instead of showing
 * its raw id (5.34.00: "List lst_…" next to a summary that named it).
 */
function useParticipantListsPreview() {
  const client = useQueryClient()
  return useQuery({
    queryKey: ['assistant', 'participant-lists-preview'],
    queryFn: participantsApi.getLists,
    placeholderData: () => client.getQueryData<ParticipantList[]>(participantsKeys.lists()),
    retry: false,
    staleTime: 0,
  })
}

function PeopleRows({ people }: Readonly<{ people: readonly ParticipantPerson[] }>) {
  const { t } = useTranslation('assistantTools')
  const notSet = <Muted text={t(`${P}.notSet`)} />
  const labels = [t(`${P}.email`), t(`${P}.name`), t(`${P}.company`), t(`${P}.title`), t(`${P}.tags`)]
  return (
    <div className="max-h-80 overflow-auto" data-testid="participant-rows">
      <table className="w-full text-[12px]" aria-label={t(`${P}.tableLabel`, { count: people.length })}>
        <TableHead labels={labels} />
        <tbody>
          {people.map((person, index) => (
            <tr key={person.email.toLowerCase()} className="border-t border-border" data-testid={`participant-row-${String(index)}`}>
              <Cell className="break-all text-text">{person.email}</Cell>
              <Cell className="break-words">{person.name ?? notSet}</Cell>
              <Cell className="break-words">{person.company ?? notSet}</Cell>
              <Cell className="break-words">{person.title ?? notSet}</Cell>
              <Cell className="break-words">{person.tags === undefined || person.tags.length === 0 ? notSet : person.tags.join(', ')}</Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The list's stored name; "Reading the list…" while it loads; the id itself only when it cannot be named (a note says why). */
function ListName({ listId, name, loading }: Readonly<{ listId: string; name: string | undefined; loading: boolean }>) {
  const { t } = useTranslation('assistantTools')
  if (name !== undefined) return <span className="font-medium text-text-strong">{name}</span>
  return loading ? <Muted text={t(`${P}.listLoading`)} /> : <Code text={listId} />
}

export function AddParticipantsPreview({ args }: Readonly<{ args: AddParticipantsArgs }>) {
  const { t } = useTranslation('assistantTools')
  const lists = useParticipantListsPreview()
  const list = lists.data?.find((entry) => entry.list_id === args.list_id)
  const { people, duplicates } = uniquePeople(args.people)
  const rows = [
    fieldRow('list', t(`${P}.list`), <ListName listId={args.list_id} name={list?.name} loading={lists.isLoading} />),
    fieldRow('count', t(`${P}.count`), t(`${P}.countValue`, { count: people.length })),
  ]
  return (
    <div className="space-y-2">
      <FieldTable rows={rows} label={t(`${P}.summaryLabel`)} />
      {lists.isSuccess && !lists.isPlaceholderData && list === undefined && <CardNote text={t(`${P}.listNotFound`)} />}
      {lists.isError && <CardNote text={t(`${P}.listReadFailed`)} />}
      <PeopleRows people={people} />
      <CardNote text={t(`${P}.reviewAllNote`)} />
      {duplicates > 0 && <CardNote text={t(`${P}.duplicatesNote`, { count: duplicates })} />}
      <CardNote text={t(`${P}.reuseNote`)} />
      <NothingSavedNote />
    </div>
  )
}

export function CreateParticipantListPreview({ args }: Readonly<{ args: CreateParticipantListArgs }>) {
  const { t } = useTranslation(['assistantTools', 'participants'])
  const notSet = <Muted text={t(`assistantTools:${P}.notSet`)} />
  const rows = [
    fieldRow('name', t(`assistantTools:${P}.listName`), args.name),
    fieldRow('kind', t(`assistantTools:${P}.kind`), <span className="badge badge-muted">{kindLabel(args.kind, t)}</span>),
    fieldRow('description', t(`assistantTools:${P}.description`), args.description ?? notSet),
  ]
  return (
    <div className="space-y-2">
      <FieldTable rows={rows} label={t(`assistantTools:${P}.listLabel`)} />
      <CardNote text={t(`assistantTools:${P}.emptyListNote`)} />
      <NothingSavedNote />
    </div>
  )
}
