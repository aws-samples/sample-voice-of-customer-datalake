/**
 * The prototype page's Feedback entry: nothing is read until it opens; it opens a
 * named dialog with the feedback view, and Escape or Close closes it with focus back
 * on the button. The page offers it to editors only (PrototypeView's own spec).
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient, renderWithQueryClient } from '../../test/query-client'
import { parsedJson } from '@test/jsonText'
import { FEEDBACK_ANSWER } from '../../api/prototype-feedback-fixtures'
import { ApiError } from '../../lib/errors'
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

  // docs/prototype-builder.md Part 3: Incorporate starts a draft from the selected items' pin ids, never their text.
  describe('Incorporate', () => {
    async function selectAndIncorporate() {
      const client = createTestQueryClient()
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      renderWithQueryClient(<PrototypeFeedbackDialog projectId="proj_1" documentId="doc_v3" />, client)
      fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
      fireEvent.click(await screen.findByRole('checkbox', { name: /The total is hidden on phones/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Incorporate' }))
      return { invalidate }
    }
    const draftPosts = () => mocks.fetchApi.mock.calls.filter(([endpoint]) => endpoint.endsWith('/drafts'))

    it('posts the selected pin ids (no text), closes the dialog and reads the jobs again', async () => {
      mocks.fetchApi.mockImplementation((endpoint) => Promise.resolve(endpoint.endsWith('/drafts')
        ? { success: true, job_id: 'job_9', status: 'pending', message: 'Prototype draft started.' }
        : FEEDBACK_ANSWER))
      const { invalidate } = await selectAndIncorporate()

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      const [endpoint, options] = draftPosts()[0] ?? []
      expect([endpoint, options?.method, parsedJson(options?.body)]).toStrictEqual([
        '/projects/proj_1/prototypes/doc_v3/drafts', 'POST', { pin_ids: ['pin_1', 'pin_2'], response_language: 'en' }])
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-jobs', 'proj_1'] })
    })

    it('keeps the dialog open with the server’s reason when it refuses', async () => {
      mocks.fetchApi.mockImplementation((endpoint) => (endpoint.endsWith('/drafts')
        ? Promise.reject(new ApiError(400, 'Every selected pin was withheld'))
        : Promise.resolve(FEEDBACK_ANSWER)))
      await selectAndIncorporate()

      expect(await screen.findByRole('alert')).toHaveTextContent('Every selected pin was withheld')
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
  })
})
