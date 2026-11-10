/**
 * Test double for deleting a board: a `deleteBoard` spy answering the given steps in turn (an Error
 * rejects, a Promise answers when it settles), then "done" for any further call.
 */
import { vi } from 'vitest'
import type { DeleteBoardStep } from './featureBoardsSchema'
import type { DeleteBoardOptions } from './featureRequestsApi'

export type DeleteAnswer = DeleteBoardStep | Error | Promise<DeleteBoardStep>

export function deleteStepsApi(...answers: DeleteAnswer[]) {
  const queue = [...answers]
  return {
    deleteBoard: vi.fn((_boardId: string, _options?: DeleteBoardOptions): Promise<DeleteBoardStep> => {
      const next = queue.shift() ?? { done: true, deleted: 0, remaining: 0 }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    }),
  }
}
