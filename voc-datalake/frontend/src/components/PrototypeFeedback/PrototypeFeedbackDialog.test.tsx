/**
 * The prototype page's Feedback entry: nothing is read until it opens; it opens a
 * named dialog with the feedback view, and Escape or Close closes it with focus back
 * on the button. The page offers it to editors only (PrototypeView's own spec).
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithQueryClient } from '../../test/query-client'
import { FEEDBACK_ANSWER } from '../../api/prototype-feedback-fixtures'
import PrototypeFeedbackDialog from './PrototypeFeedbackDialog'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>() }))

vi.mock('../../api/client', () => ({ fetchApi: mocks.fetchApi }))

beforeEach(() => {
  mocks.fetchApi.mockReset().mockResolvedValue(FEEDBACK_ANSWER)
})

describe('PrototypeFeedbackDialog', () => {
  it('reads nothing until opened, then shows the feedback in a named dialog', async () => {
    renderWithQueryClient(<PrototypeFeedbackDialog projectId="proj_1" documentId="doc_v3" />)
    expect(mocks.fetchApi).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const dialog = await screen.findByRole('dialog', { name: 'Prototype feedback' })
    expect(dialog).toBeInTheDocument()
    expect(await screen.findByText('2 testers said this')).toBeInTheDocument()
    expect(mocks.fetchApi).toHaveBeenCalledWith('/projects/proj_1/prototypes/doc_v3/feedback')
  })

  it('closes on Escape and on Close, returning focus to the button', async () => {
    renderWithQueryClient(<PrototypeFeedbackDialog projectId="proj_1" documentId="doc_v3" />)
    const open = screen.getByRole('button', { name: 'Feedback' })
    open.focus()
    fireEvent.click(open)
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(open).toHaveFocus())
    fireEvent.click(open)
    fireEvent.click(await screen.findByRole('button', { name: 'Close feedback' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
