/**
 * The one board-delete dialog: an empty board is a plain confirm; a board with requests asks for its
 * name, shows progress, stays open on a failure (Delete resumes) and closes when done; a plain delete
 * refused with 409 `board_not_empty` switches it to the with-requests mode.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { ApiError } from '../../lib/errors'
import DeleteBoardDialog from './DeleteBoardDialog'
import { fixtureBoard } from './feature-board-fixtures'
import { deleteStepsApi } from '../../api/board-deletion-fixtures'
import type { DeleteBoardStep, FeatureBoard } from '../../api/featureBoardsSchema'

const EMPTY = fixtureBoard('blank', { board_id: 'brd_empty', name: 'Example Air ideas', request_count: 0 })
const FULL = fixtureBoard('sales', { board_id: 'brd_full', name: 'Example Air sales', request_count: 3 })

function renderDialog(board: FeatureBoard, api: ReturnType<typeof deleteStepsApi>) {
  const onDeleted = vi.fn()
  const onCancel = vi.fn()
  renderWithQueryClient(<DeleteBoardDialog board={board} api={api} onCancel={onCancel} onDeleted={onDeleted} />)
  const dialog = within(screen.getByRole('dialog'))
  return { onDeleted, onCancel, dialog, confirm: () => dialog.getByRole('button', { name: 'Delete' }) }
}

describe('an empty board', () => {
  it('is deleted with one plain call, no name to type', async () => {
    const user = userEvent.setup()
    const api = deleteStepsApi({ done: true, deleted: 0, remaining: 0 })
    const { dialog, confirm, onDeleted } = renderDialog(EMPTY, api)
    expect(dialog.getByText('“Example Air ideas” is deleted for everyone. This cannot be undone.')).toBeInTheDocument()
    expect(dialog.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(confirm())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(api.deleteBoard).toHaveBeenCalledExactlyOnceWith('brd_empty')
  })

  it('switches to the with-requests mode when the API says it has requests (a stale count)', async () => {
    const user = userEvent.setup()
    const { dialog, confirm } = renderDialog(EMPTY, deleteStepsApi(new ApiError(409, 'board_not_empty')))
    await user.click(confirm())
    expect(await dialog.findByRole('textbox', { name: 'Type the board name to confirm' })).toBeInTheDocument()
    expect(dialog.getByText(/“Example Air ideas” has requests now\./)).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
    expect(confirm()).toBeDisabled()
  })

  it('after that switch, deletes it with its requests once the name is typed', async () => {
    const user = userEvent.setup()
    const api = deleteStepsApi(new ApiError(409, 'board_not_empty'))
    const { dialog, confirm, onDeleted } = renderDialog(EMPTY, api)
    await user.click(confirm())
    await user.type(await dialog.findByRole('textbox'), 'Example Air ideas')
    await user.click(confirm())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(api.deleteBoard).toHaveBeenLastCalledWith('brd_empty', { withRequests: true })
  })
})

describe('a board with requests', () => {
  it('says what goes for good and what stays, and enables Delete only for the exact name', async () => {
    const user = userEvent.setup()
    const { dialog, confirm } = renderDialog(FULL, deleteStepsApi())
    expect(dialog.getByText(
      '“Example Air sales”, its 3 requests and every +1 on them are deleted permanently. This cannot be undone. Projects already created from its requests are kept.',
    )).toBeInTheDocument()
    const name = dialog.getByRole('textbox', { name: 'Type the board name to confirm' })
    expect(confirm()).toBeDisabled()
    await user.type(name, 'Example Air')
    expect(confirm()).toBeDisabled()
    await user.type(name, ' sales  ')
    expect(confirm()).toBeEnabled()
  })

  it('shows progress while it deletes, stays open, then closes and cleans up when done', async () => {
    const user = userEvent.setup()
    const last: { release: (step: DeleteBoardStep) => void } = { release: () => {} }
    const api = deleteStepsApi(
      { done: false, deleted: 2, remaining: 1 },
      new Promise<DeleteBoardStep>((resolve) => { last.release = resolve }),
    )
    const { dialog, confirm, onDeleted } = renderDialog(FULL, api)
    await user.type(dialog.getByRole('textbox'), 'Example Air sales')
    await user.click(confirm())
    const status = await dialog.findByRole('status')
    expect([status.textContent, status.getAttribute('aria-live')]).toStrictEqual(['Deleted 2 of 3 requests…', 'polite'])
    expect(onDeleted).not.toHaveBeenCalled()
    last.release({ done: true, deleted: 1, remaining: 0 })
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(api.deleteBoard).toHaveBeenCalledTimes(2)
  })

  it('keeps the dialog open on a failure, and a second Delete resumes', async () => {
    const user = userEvent.setup()
    const api = deleteStepsApi({ done: false, deleted: 2, remaining: 1 }, new ApiError(403, 'forbidden'), { done: true, deleted: 1, remaining: 0 })
    const { dialog, confirm, onDeleted, onCancel } = renderDialog(FULL, api)
    await user.type(dialog.getByRole('textbox'), 'Example Air sales')
    await user.click(confirm())
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'You are not allowed to do that. Press Delete again to continue where it stopped.',
    )
    // Still open: neither closed as done nor cancelled.
    expect([onDeleted.mock.calls.length, onCancel.mock.calls.length]).toStrictEqual([0, 0])
    await user.click(confirm())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(api.deleteBoard).toHaveBeenCalledTimes(3)
  })
})
