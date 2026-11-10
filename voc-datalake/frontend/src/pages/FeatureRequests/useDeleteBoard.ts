/**
 * @fileoverview The state behind the one board-delete dialog (DeleteBoardDialog.tsx): an empty
 * board is deleted with one plain call; a board with requests is deleted with them, step by step
 * (`deleteBoardFully`), after its name is typed. A plain delete the API refuses with 409
 * `board_not_empty` (the cached count was stale) switches the dialog to the with-requests mode.
 * @module pages/FeatureRequests/useDeleteBoard
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { deleteBoardFully } from '../../api/boardDeletion'
import { serverReason } from '../../lib/errors'
import type { DeleteProgress } from '../../api/boardDeletion'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import type { FeatureRequestsApi } from '../../api/featureRequestsApi'

type DeleteMode = 'plain' | 'withRequests'

/** 409 `board_not_empty`: the board has requests (a plain delete cannot remove it). */
function isBoardNotEmpty(error: unknown): boolean {
  return apiErrorStatus(error) === 409 && serverReason(error) === 'board_not_empty'
}

/** The board's name as typed, compared trimmed on both sides. */
function namesMatch(typed: string, name: string): boolean {
  return typed.trim() !== '' && typed.trim() === name.trim()
}

export function useDeleteBoard(board: FeatureBoard, api: Pick<FeatureRequestsApi, 'deleteBoard'>, onDeleted: () => Promise<void> | void) {
  const [mode, setMode] = useState<DeleteMode>(board.request_count > 0 ? 'withRequests' : 'plain')
  const [typed, setTyped] = useState('')
  const [progress, setProgress] = useState<DeleteProgress | null>(null)
  const remove = useMutation({
    mutationFn: (run: DeleteMode) => (run === 'plain'
      ? api.deleteBoard(board.board_id)
      : deleteBoardFully(api, board.board_id, setProgress)),
    onSuccess: () => onDeleted(),
    onError: (error, run) => {
      if (run === 'plain' && isBoardNotEmpty(error)) setMode('withRequests')
    },
  })
  // The 409 that switched the mode is explained by the with-requests message, not shown as a failure.
  const error = isBoardNotEmpty(remove.error) ? null : remove.error
  const canConfirm = mode === 'plain' || namesMatch(typed, board.name)
  return {
    mode, typed, setTyped, progress, error, canConfirm,
    isPending: remove.isPending,
    confirm: () => { if (canConfirm) remove.mutate(mode) },
  }
}
