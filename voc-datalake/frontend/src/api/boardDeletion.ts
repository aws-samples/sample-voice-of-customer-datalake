/**
 * @fileoverview Delete a board together with its requests: `DELETE /feature-requests/boards/{id}
 * ?with_requests=true` deletes a page of requests per call (the board is archived on the first one)
 * and the board itself once none remain, so the client repeats the call until the API says `done`.
 * The call is idempotent: after any failure, starting again resumes where it stopped.
 * @module api/boardDeletion
 */
import type { DeleteBoardStep } from './featureBoardsSchema'
import type { FeatureRequestsApi } from './featureRequestsApi'

/** At most this many calls; a board that is still not gone by then is reported, not looped on. */
export const MAX_DELETE_STEPS = 200

/** How far a delete is: requests deleted so far (this run) and how many remain. */
export interface DeleteProgress {
  readonly deleted: number
  readonly remaining: number
}

/** The board was not gone after {@link MAX_DELETE_STEPS} calls. Deleting again continues. */
export class BoardDeleteIncompleteError extends Error {
  constructor(progress: DeleteProgress) {
    super(`The board was not deleted after ${String(MAX_DELETE_STEPS)} steps; ${String(progress.remaining)} requests remain.`)
    this.name = 'BoardDeleteIncompleteError'
  }
}

interface DeleteRun {
  readonly api: Pick<FeatureRequestsApi, 'deleteBoard'>
  readonly boardId: string
  readonly onProgress: (progress: DeleteProgress) => void
}

/** One call, then the next while the board is not gone, `stepsLeft` at most. */
async function continueDelete(run: DeleteRun, before: DeleteProgress, stepsLeft: number): Promise<DeleteBoardStep> {
  if (stepsLeft === 0) throw new BoardDeleteIncompleteError(before)
  const answer = await run.api.deleteBoard(run.boardId, { withRequests: true })
  const progress = { deleted: before.deleted + answer.deleted, remaining: answer.done ? 0 : answer.remaining }
  run.onProgress(progress)
  return answer.done ? { done: true, ...progress } : continueDelete(run, progress, stepsLeft - 1)
}

/**
 * Calls the with-requests delete until the board is gone, reporting the running totals after each
 * call. Any failed call stops the loop (its error is thrown as is).
 */
export function deleteBoardFully(
  api: Pick<FeatureRequestsApi, 'deleteBoard'>,
  boardId: string,
  onProgress: (progress: DeleteProgress) => void,
): Promise<DeleteBoardStep> {
  return continueDelete({ api, boardId, onProgress }, { deleted: 0, remaining: 0 }, MAX_DELETE_STEPS)
}
