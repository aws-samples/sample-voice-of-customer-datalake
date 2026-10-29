/**
 * @fileoverview REST executors of the `participants` pack writes (docs/participants.md),
 * through `participantsApi` (the user's own Cognito token; every signed-in user may
 * call both routes):
 * - `create_participant_list` → `POST /participants/lists`; the summary hands the
 *   new list_id back to the model for a following `add_participants`;
 * - `add_participants` → `POST /participants/lists/{list_id}/members` (`origin: 'assistant'`) with the
 *   card's rows, one per address (`uniquePeople`, as the card shows them); the
 *   summary reports the route's `{added, already, created, rejected}`.
 * Summaries are English: they are the tool result the model reads.
 *
 * @module assistant/approvals/participantExecutors
 */
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import { invalidateKeys } from './invalidation'
import { uniquePeople } from './participantSchemas'
import type { AddMembersResult } from '../../api/participantsSchema'
import type { AddParticipantsArgs, CreateParticipantListArgs } from './participantSchemas'
import type { WriteToolExecutionContext } from '../types'

/** Rejected addresses named in the summary at most (the rest are counted). */
const MAX_NAMED_REJECTIONS = 20

/** Every participants read (lists, members, people, project links). */
const PARTICIPANT_KEYS = [participantsKeys.all()]

export async function createParticipantList(args: CreateParticipantListArgs, ctx: WriteToolExecutionContext) {
  const list = await participantsApi.createList({
    name: args.name, kind: args.kind, ...(args.description === undefined ? {} : { description: args.description }),
  })
  void invalidateKeys(ctx.queryClient, PARTICIPANT_KEYS)
  return {
    summary: `Created the participant list "${list.name}" (${list.kind}, list_id ${list.list_id}). Add people to it with add_participants and this list_id.`,
    data: { list_id: list.list_id, name: list.name, kind: list.kind },
  }
}

function rejectedText(rejected: AddMembersResult['rejected']): string {
  if (rejected.length === 0) return ''
  const named = rejected.slice(0, MAX_NAMED_REJECTIONS).map((entry) => `${entry.email} (${entry.reason})`).join(', ')
  const more = rejected.length > MAX_NAMED_REJECTIONS ? ` and ${String(rejected.length - MAX_NAMED_REJECTIONS)} more` : ''
  return ` Not added: ${named}${more}.`
}

export async function addParticipants(args: AddParticipantsArgs, ctx: WriteToolExecutionContext) {
  const { people, duplicates } = uniquePeople(args.people)
  const result = await participantsApi.addMembers(args.list_id, { people, origin: 'assistant' })
  void invalidateKeys(ctx.queryClient, PARTICIPANT_KEYS)
  const collapsed = duplicates === 0 ? '' : ` Repeated rows dropped (same address): ${String(duplicates)}.`
  return {
    summary: `Sent ${String(people.length)} people to participant list ${args.list_id}: ${String(result.added)} added, `
      + `${String(result.already)} already on the list, ${String(result.created)} newly created, `
      + `${String(result.rejected.length)} rejected.${rejectedText(result.rejected)}${collapsed}`,
    data: { list_id: args.list_id, sent: people.length, duplicates_collapsed: duplicates, ...result },
  }
}
