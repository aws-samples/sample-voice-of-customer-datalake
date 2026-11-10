/**
 * Saving a processed record from the Data Explorer, through the real mutation hook: a save that lands closes
 * the editor; a 409 (the record changed after the editor opened it, `PUT /data-explorer/feedback`) keeps it
 * open with the translated reload message; any other refusal shows the server's own message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestRouter } from '../../test/TestRouter'
import { renderWithQueryClient } from '../../test/query-client'
import { configStoreModule, feedbackItem } from '../Categories/categories-fixtures'
import { api } from '../../api/client'
import { ApiError } from '../../lib/errors'
import type { FeedbackItem } from '../../api/types'
import enDataExplorer from '../../../public/locales/en/dataExplorer.json'

const OPENED_AT = '2026-11-01T00:00:00+00:00'
const RECORD = feedbackItem({ feedback_id: 'fb-1', original_text: 'Late parcel', updated_at: OPENED_AT })

// Partial: the real mutation hook invalidates the real `dataExplorerKeys` after a save.
vi.mock('./useDataExplorerQueries', async (importOriginal) => {
  const { dataExplorerQueriesResult } = await import('./data-explorer-fixtures')
  return {
    ...await importOriginal<typeof import('./useDataExplorerQueries')>(),
    useDataExplorerQueries: () => dataExplorerQueriesResult(),
  }
})

vi.mock('../../store/configStore', () => configStoreModule())
vi.mock('./DataQualitySection', () => ({ default: () => null }))

// The list opens the editor on one record; the editor saves the record as opened and shows `error`.
vi.mock('./ProcessedFeedbackView', () => ({
  default: ({ onEdit }: { onEdit: (item: FeedbackItem) => void }) => (
    <button type="button" onClick={() => onEdit(RECORD)}>Edit record</button>
  ),
}))
vi.mock('./EditModal', () => ({
  default: ({ data, onSave, onClose, error }: { data: unknown; onSave: (content: unknown) => void; onClose: () => void; error?: string }) => (
    <div data-testid="edit-modal">
      <button type="button" onClick={() => onSave({ ...(typeof data === 'object' ? data : {}), original_text: 'Edited' })}>Save</button>
      <button type="button" onClick={onClose}>Close</button>
      {error !== undefined && <span role="alert">{error}</span>}
    </div>
  ),
}))

import DataExplorer from './DataExplorer'

async function openEditorAndSave() {
  const user = userEvent.setup()
  renderWithQueryClient(<TestRouter initialEntries={['/data-explorer?view=processed']}><DataExplorer /></TestRouter>)
  await user.click(screen.getByRole('button', { name: 'Edit record' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  return user
}

describe('DataExplorer - saving a processed record', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('closes the editor once the save lands, having sent the stamp the record was opened with', async () => {
    const save = vi.spyOn(api, 'saveDataExplorerFeedback').mockResolvedValue({ success: true })
    await openEditorAndSave()

    await waitFor(() => expect(screen.queryByTestId('edit-modal')).not.toBeInTheDocument())
    expect(save).toHaveBeenCalledWith('fb-1', expect.objectContaining({ original_text: 'Edited', updated_at: OPENED_AT }))
  })

  it('keeps the editor open with the translated reload message when the record changed since it was opened (409)', async () => {
    vi.spyOn(api, 'saveDataExplorerFeedback').mockRejectedValue(new ApiError(409, 'Item changed since it was read'))
    await openEditorAndSave()

    expect(await screen.findByRole('alert')).toHaveTextContent(enDataExplorer.editModal.staleRecord)
    expect(screen.getByTestId('edit-modal')).toBeInTheDocument()
  })

  it('opens the next editor without the previous refusal', async () => {
    vi.spyOn(api, 'saveDataExplorerFeedback').mockRejectedValue(new ApiError(409))
    const user = await openEditorAndSave()
    await screen.findByRole('alert')

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Edit record' }))

    expect(screen.getByTestId('edit-modal')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("shows the server's own message for any other refusal", async () => {
    vi.spyOn(api, 'saveDataExplorerFeedback').mockRejectedValue(new ApiError(400, 'category: unknown value'))
    await openEditorAndSave()

    expect(await screen.findByRole('alert')).toHaveTextContent('category: unknown value')
    expect(screen.getByTestId('edit-modal')).toBeInTheDocument()
  })
})
