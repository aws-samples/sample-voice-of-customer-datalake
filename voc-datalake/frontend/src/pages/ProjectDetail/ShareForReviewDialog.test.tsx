/**
 * "Share for review": create a review link (anyone with the link, or listed domains and
 * addresses; 30 days by default), then show it with Copy, its audience and expiry, and turn it
 * off. A refused create says the server's reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../lib/errors'
import ShareForReviewDialog from './ShareForReviewDialog'
import type { ShareSettings } from '../../api/documentReviewApi'
import type { ReviewShare } from '../../api/documentReviewSchema'

const SHARE_ID = `shr_${'b'.repeat(32)}`

const SHARE: ReviewShare = {
  share_id: SHARE_ID, path: `/review/${SHARE_ID}`, audience: { mode: 'list', domains: ['example.com'], emails: ['sam@example.org'] },
  created_at: '2026-10-28T10:00:00Z', created_by_name: 'Rui', expires_at: '2026-11-27T10:00:00Z', active: true,
}

const onCreate = vi.fn<(settings: ShareSettings) => Promise<unknown>>()
const onRevoke = vi.fn<() => Promise<unknown>>()
const onClose = vi.fn()

function renderDialog(share: ReviewShare | null) {
  return render(<ShareForReviewDialog share={share} onCreate={onCreate} onRevoke={onRevoke} onClose={onClose} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  onCreate.mockResolvedValue(undefined)
  onRevoke.mockResolvedValue(undefined)
})

describe('creating a review link', () => {
  it('creates an anyone-with-the-link link for 30 days by default', async () => {
    const user = userEvent.setup()
    renderDialog(null)

    expect(screen.getByRole('radio', { name: /Anyone with the link/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Create review link' }))

    expect(onCreate).toHaveBeenCalledWith({ audience: { mode: 'anyone', domains: [], emails: [] }, expires_in_days: 30 })
  })

  it('splits a listed audience into domains and addresses, lower-cased', async () => {
    const user = userEvent.setup()
    renderDialog(null)

    await user.click(screen.getByRole('radio', { name: /Only these domains or addresses/ }))
    await user.type(screen.getByLabelText('Domains and email addresses'), 'Example.com, Sam@Example.org\nother.example')
    await user.selectOptions(screen.getByLabelText('Link expires after'), '7')
    await user.click(screen.getByRole('button', { name: 'Create review link' }))

    expect(onCreate).toHaveBeenCalledWith({
      audience: { mode: 'list', domains: ['example.com', 'other.example'], emails: ['sam@example.org'] },
      expires_in_days: 7,
    })
  })

  it('cannot create a listed link with an empty list', async () => {
    const user = userEvent.setup()
    renderDialog(null)

    await user.click(screen.getByRole('radio', { name: /Only these domains or addresses/ }))

    expect(screen.getByRole('button', { name: 'Create review link' })).toBeDisabled()
  })

  it("says the server's reason when the link is refused", async () => {
    onCreate.mockRejectedValue(new ApiError(400, 'audience: "not a domain" is not a domain or an email address'))
    const user = userEvent.setup()
    renderDialog(null)

    await user.click(screen.getByRole('button', { name: 'Create review link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('is not a domain or an email address')
  })
})

describe('an active review link', () => {
  it('shows the full link, who may open it and when it expires', () => {
    renderDialog(SHARE)

    expect(screen.getByLabelText('Review link')).toHaveValue(`${window.location.origin}/review/${SHARE_ID}`)
    expect(screen.getByText('example.com, sam@example.org')).toBeInTheDocument()
    expect(screen.getByText('Expires')).toBeInTheDocument()
  })

  it('copies the link and says so', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    renderDialog(SHARE)

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/review/${SHARE_ID}`)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('names an anyone-with-the-link audience in words', () => {
    renderDialog({ ...SHARE, audience: { mode: 'anyone', domains: [], emails: [] } })

    expect(screen.getByText('Anyone with the link')).toBeInTheDocument()
  })

  it('turns the link off', async () => {
    const user = userEvent.setup()
    renderDialog(SHARE)

    await user.click(screen.getByRole('button', { name: 'Turn off link' }))

    await waitFor(() => expect(onRevoke).toHaveBeenCalledExactlyOnceWith())
  })
})
