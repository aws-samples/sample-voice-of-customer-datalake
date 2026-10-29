/**
 * @fileoverview The sentence for a failed board write (WriteError.tsx): the API answers
 * `{success: false, error: <English sentence or code>}`. A code the board names (`rate_limited`,
 * `slug_taken`, `board_not_empty`, `status_in_use`) wins, then a status with a translated sentence,
 * then the server's own reason, then the generic sentence.
 * @module pages/FeatureRequests/writeErrorText
 */
import { apiErrorStatus, messageKeyForStatus } from '../../api/apiErrorStatus'
import { serverReason } from '../../lib/errors'
import { CONFLICT_CODE_ERRORS, GENERIC_WRITE_ERROR, RATE_LIMITED_ERROR, WRITE_ERRORS } from './boardLabels'

/** The message key of an error code the API sent, when the board has words for it. */
function codeMessageKey(status: number | null, reason: string | null): string | undefined {
  if (reason === null) return undefined
  if (status === 429 && reason === 'rate_limited') return RATE_LIMITED_ERROR.messageKey
  return status === 409 ? CONFLICT_CODE_ERRORS[reason]?.messageKey : undefined
}

/** The sentence for a failed board write, translated whenever a translation exists. */
export function writeErrorText(error: unknown, t: (key: string) => string): string {
  const status = apiErrorStatus(error)
  const reason = serverReason(error)
  const coded = codeMessageKey(status, reason)
  if (coded !== undefined) return t(coded)
  const translated = WRITE_ERRORS.some((entry) => entry.status === status)
  if (!translated && reason !== null) return reason
  return t(messageKeyForStatus(error, WRITE_ERRORS, GENERIC_WRITE_ERROR))
}
