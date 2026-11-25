/**
 * @fileoverview A failed library request as what the person is told (lambda/shared/library_routes.py and
 * library_store.py: the codes beside each 400, 403 and 409), read by its `code`, never its sentence. The words are
 * the page's, held as `messageKey` data so the i18n audit sees them.
 *
 * @module pages/Library/libraryErrors
 */
import type { TFunction } from 'i18next'
import { LibraryUploadError } from '../../api/libraryApi'
import { apiErrorCode } from '../../lib/errors'
import { apiErrorStatus } from '../../api/apiErrorStatus'

export type LibraryFailure =
  | 'slugTaken' | 'libraryFull' | 'unsupported' | 'tooLarge' | 'stale' | 'notUploaded' | 'uploadMismatch'
  | 'forbidden' | 'deleteForbidden' | 'notFound' | 'notFailed' | 'uploadRefused' | 'network' | 'other'

const BY_CODE: Readonly<Record<string, LibraryFailure>> = {
  slug_taken: 'slugTaken',
  library_full: 'libraryFull',
  unsupported_type: 'unsupported',
  too_large: 'tooLarge',
  stale: 'stale',
  not_uploaded: 'notUploaded',
  upload_mismatch: 'uploadMismatch',
  not_failed: 'notFailed',
}

const BY_STATUS: Readonly<Record<number, LibraryFailure>> = { 403: 'forbidden', 404: 'notFound' }

const MESSAGES: Readonly<Record<LibraryFailure, { readonly messageKey: string }>> = {
  slugTaken: { messageKey: 'library:errors.slugTaken' },
  libraryFull: { messageKey: 'library:errors.libraryFull' },
  unsupported: { messageKey: 'library:errors.unsupported' },
  tooLarge: { messageKey: 'library:errors.tooLarge' },
  stale: { messageKey: 'library:errors.stale' },
  notUploaded: { messageKey: 'library:errors.notUploaded' },
  uploadMismatch: { messageKey: 'library:errors.uploadMismatch' },
  forbidden: { messageKey: 'library:errors.writeForbidden' },
  deleteForbidden: { messageKey: 'library:errors.deleteForbidden' },
  notFound: { messageKey: 'library:errors.notFound' },
  notFailed: { messageKey: 'library:errors.notFailed' },
  uploadRefused: { messageKey: 'library:errors.uploadRefused' },
  network: { messageKey: 'library:errors.network' },
  other: { messageKey: 'library:errors.other' },
}

/** What went wrong; a 403 of a delete is its own (only an admin or the uploader deletes). */
export function libraryFailure(error: unknown, action: 'write' | 'delete' = 'write'): LibraryFailure {
  if (error instanceof LibraryUploadError) return error.status === 0 ? 'network' : 'uploadRefused'
  const byCode = BY_CODE[apiErrorCode(error) ?? '']
  if (byCode !== undefined) return byCode
  const byStatus = BY_STATUS[apiErrorStatus(error) ?? 0] ?? 'other'
  return byStatus === 'forbidden' && action === 'delete' ? 'deleteForbidden' : byStatus
}

export function failureText(t: TFunction, failure: LibraryFailure): string {
  return t(MESSAGES[failure].messageKey)
}
