/**
 * @fileoverview The public unsubscribe page: nothing is posted on load (mail scanners prefetch
 * links), one press posts the token, then a confirmation; a failure says so; no token, no button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '@test/TestRouter'
import { createTestQueryClient } from '@test/query-client'
import { useConfigStore } from '../../store/configStore'
import Unsubscribe from './Unsubscribe'

const fetchMock = vi.fn<typeof fetch>()

function renderAt(entry: string) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TestRouter initialEntries={[entry]}><Unsubscribe /></TestRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com/v1' } }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the unsubscribe page', () => {
  it('posts nothing when the page loads', () => {
    renderAt('/unsubscribe?t=tok_abc')
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the token once the button is pressed, then confirms', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    renderAt('/unsubscribe?t=tok_abc')
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }))
    expect(await screen.findByText('You are unsubscribed')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/unsubscribe', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ token: 'tok_abc' }),
    }))
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('says it did not work when the request fails, and keeps the button', async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValue(new TypeError('offline'))
    renderAt('/unsubscribe?t=tok_abc')
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not work/i)
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeEnabled()
  })

  it('explains an incomplete link instead of offering a button', () => {
    renderAt('/unsubscribe')
    expect(screen.getByText(/this link is incomplete/i)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
