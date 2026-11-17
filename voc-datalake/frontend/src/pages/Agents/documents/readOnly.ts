/**
 * @fileoverview What the Agents documents share as read-only surfaces: a read of a version that may be gone (a 404 is
 * "none", never an error: the adapter's `load` contract), and the surface's `onSaved` for a document never saved here.
 *
 * @module pages/Agents/documents/readOnly
 */
import { apiErrorStatus } from '../../../api/apiErrorStatus'

/** `read`'s answer, or none (undefined) when the server has no such thing (404); any other failure stays one. */
export async function unlessGone<T>(read: () => Promise<T>): Promise<T | undefined> {
  const answer = await read().then((value) => ({ value }), (error: unknown) => {
    if (apiErrorStatus(error) === 404) return null
    throw error
  })
  return answer?.value
}

/** A read-only surface's `onSaved`: it never saves, so there is nothing to select. */
export function neverSaved(): void {
  // A skill version, a brief, a report, a pack or a preview is decided elsewhere: never saved through the surface.
}
