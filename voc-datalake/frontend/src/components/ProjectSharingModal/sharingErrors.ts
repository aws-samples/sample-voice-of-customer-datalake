/**
 * @fileoverview A failed sharing call, as a translatable message key.
 *
 * Keyed on the HTTP status (see api/apiErrorStatus.ts): the sharing contract gives
 * each status one meaning, which is what makes this table honest rather than a
 * guess. `fetchApi` now also carries the server's `message` on the `ApiError`;
 * a future refinement could show it when it differs from `API Error: <status>`.
 *
 * Keys are namespace-qualified `messageKey:` data so scripts/i18n-check.mjs
 * counts them as used.
 *
 * @module components/ProjectSharingModal/sharingErrors
 */
import { apiErrorStatus } from '../../api/apiErrorStatus'

const MESSAGES_BY_STATUS: Readonly<Record<number, { messageKey: string }>> = {
  400: { messageKey: 'projects:sharing.errors.invalid' },
  403: { messageKey: 'projects:sharing.errors.forbidden' },
  404: { messageKey: 'projects:sharing.errors.notFound' },
  409: { messageKey: 'projects:sharing.errors.conflict' },
}

const GENERIC = { messageKey: 'projects:sharing.errors.generic' }

export function sharingErrorKey(reason: unknown): string {
  const status = apiErrorStatus(reason)
  return ((status === null ? undefined : MESSAGES_BY_STATUS[status]) ?? GENERIC).messageKey
}
