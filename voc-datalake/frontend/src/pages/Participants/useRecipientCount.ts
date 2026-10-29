/**
 * @fileoverview How many distinct people an ask would reach: the chosen lists' members
 * (each list read once, shared with the list view's cache) plus the people picked one by one.
 * @module pages/Participants/useRecipientCount
 */
import { useQueries } from '@tanstack/react-query'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import { countRecipients } from './askDraft'

/** The distinct recipient count, or null while a chosen list's members are still loading. */
export function useRecipientCount(listIds: readonly string[], personIds: readonly string[]): number | null {
  const members = useQueries({
    queries: listIds.map((listId) => ({ queryKey: participantsKeys.list(listId), queryFn: () => participantsApi.getList(listId) })),
  })
  if (members.some((query) => query.data === undefined)) return null
  return countRecipients(members.map((query) => (query.data?.members ?? []).map((m) => m.person_id)), personIds)
}
