/**
 * @fileoverview A failed library request read by its code (lambda/shared/library_store.py, library_routes.py), then
 * its status, then as a failed PUT; and said in the page's words.
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { LibraryUploadError } from '../../api/libraryApi'
import { ApiError } from '../../lib/errors'
import { libraryFailureText, libraryFailure } from './libraryErrors'

describe('libraryFailure', () => {
  it.each([
    [new ApiError(409, 'taken', 'slug_taken'), 'slugTaken'],
    [new ApiError(409, 'full', 'library_full'), 'libraryFull'],
    [new ApiError(400, 'no', 'unsupported_type'), 'unsupported'],
    [new ApiError(400, 'big', 'too_large'), 'tooLarge'],
    [new ApiError(409, 'stale', 'stale'), 'stale'],
    [new ApiError(409, 'gone', 'not_uploaded'), 'notUploaded'],
    [new ApiError(409, 'other', 'upload_mismatch'), 'uploadMismatch'],
    [new ApiError(409, 'ready', 'not_failed'), 'notFailed'],
    [new ApiError(403, 'no'), 'forbidden'],
    [new ApiError(404, 'gone'), 'notFound'],
    [new ApiError(500), 'other'],
    [new LibraryUploadError(403), 'uploadRefused'],
    [new LibraryUploadError(0), 'network'],
    [new Error('boom'), 'other'],
  ])('reads %o as %s', (error, failure) => {
    expect(libraryFailure(error)).toBe(failure)
  })

  it('reads a refused delete as the uploader-or-admin rule', () => {
    expect([libraryFailure(new ApiError(403, 'no'), 'delete'), libraryFailure(new ApiError(409, 'x', 'stale'), 'delete')]).toStrictEqual(['deleteForbidden', 'stale'])
  })
})

describe('libraryFailureText', () => {
  it('says each failure in the page\'s words', () => {
    const t = i18n.getFixedT('en', 'library')
    expect([libraryFailureText(t, 'slugTaken'), libraryFailureText(t, 'deleteForbidden')]).toStrictEqual([
      'Another library item already has this short name. Choose another.',
      'Only an admin or the person who uploaded it can delete this item.',
    ])
  })
})
