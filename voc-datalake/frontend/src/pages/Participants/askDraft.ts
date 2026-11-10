/**
 * @fileoverview The "New ask" composer's draft: what it holds, what is wrong with it
 * (checked before the server would refuse), and the request body it becomes.
 * @module pages/Participants/askDraft
 */
import { MAX_MESSAGE_CHARS, MAX_RECIPIENTS, MAX_SUBJECT_CHARS } from '../../api/participantsApi'
import type { AskInput } from '../../api/participantsApi'
import { isHttpsUrl } from '../../utils/httpsUrl'

export interface AskDraft {
  readonly listIds: readonly string[]
  readonly personIds: readonly string[]
  readonly subject: string
  readonly message: string
  readonly linkKind: 'form' | 'url'
  readonly formId: string
  readonly url: string
}

export type DraftIssue =
  | 'noRecipients' | 'tooManyRecipients' | 'subjectMissing' | 'subjectTooLong'
  | 'messageMissing' | 'messageTooLong' | 'formMissing' | 'urlNotHttps'

export function emptyDraft(listIds: readonly string[] = [], personIds: readonly string[] = []): AskDraft {
  return { listIds, personIds, subject: '', message: '', linkKind: 'form', formId: '', url: '' }
}

function recipientIssue(draft: AskDraft, recipientCount: number | null): DraftIssue | null {
  if (draft.listIds.length === 0 && draft.personIds.length === 0) return 'noRecipients'
  if (recipientCount !== null && recipientCount > MAX_RECIPIENTS) return 'tooManyRecipients'
  return null
}

function textIssues(draft: AskDraft): DraftIssue[] {
  const issues: DraftIssue[] = []
  if (draft.subject.trim() === '') issues.push('subjectMissing')
  if (draft.subject.length > MAX_SUBJECT_CHARS) issues.push('subjectTooLong')
  if (draft.message.trim() === '') issues.push('messageMissing')
  if (draft.message.length > MAX_MESSAGE_CHARS) issues.push('messageTooLong')
  return issues
}

function linkIssue(draft: AskDraft): DraftIssue | null {
  if (draft.linkKind === 'form') return draft.formId === '' ? 'formMissing' : null
  return isHttpsUrl(draft.url.trim()) ? null : 'urlNotHttps'
}

/** Every problem the draft has, in the order the form shows its fields. `recipientCount` null = still counting. */
export function draftIssues(draft: AskDraft, recipientCount: number | null): DraftIssue[] {
  return [recipientIssue(draft, recipientCount), ...textIssues(draft), linkIssue(draft)]
    .filter((issue): issue is DraftIssue => issue !== null)
}

export function toAskInput(draft: AskDraft, projectId: string): AskInput {
  return {
    ...(projectId === '' ? {} : { project_id: projectId }),
    list_ids: draft.listIds,
    person_ids: draft.personIds,
    subject: draft.subject.trim(),
    message: draft.message.trim(),
    link: draft.linkKind === 'form' ? { kind: 'form', form_id: draft.formId } : { kind: 'url', url: draft.url.trim() },
  }
}

/** Distinct people across the chosen lists' members and the people picked one by one. */
export function countRecipients(memberIdsPerList: ReadonlyArray<readonly string[]>, personIds: readonly string[]): number {
  return new Set([...memberIdsPerList.flat(), ...personIds]).size
}

export function toggle(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]
}
