/**
 * @fileoverview The sentence for why an address was not added: a list's add result and a
 * project's invite (both answer 200 with `rejected: [{email, reason}]`).
 * @module pages/Participants/rejectReason
 */
import type { RejectReason } from '../../api/participantsSchema'

type Translate = (key: string) => string

export function rejectReason(reason: RejectReason, t: Translate): string {
  switch (reason) {
    case 'invalid_email': return t('participants:errors.invalidEmail')
    case 'external_not_allowed': return t('participants:errors.externalNotAllowed')
    case 'unsubscribed': return t('participants:errors.unsubscribedPerson')
  }
}
