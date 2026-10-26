/**
 * @fileoverview Administration → Sources → Email inbox: admin-only, off until deployed, today's
 * counters, the caps form and the feedback_type dimension prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { DEFAULT_EMAIL_INBOX, normalizeEmailInbox } from '../../api/emailInboxApi'
import type { EmailInboxCaps, EmailInboxStatus } from '../../api/emailInboxApi'
import EmailInboxCard from './EmailInboxCard'

const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => auth.isAdmin }))

const api = vi.hoisted(() => ({
  get: vi.fn<() => Promise<EmailInboxStatus>>(),
  saveCaps: vi.fn<(caps: EmailInboxCaps) => Promise<EmailInboxStatus>>(),
  createFeedbackTypeDimension: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('../../api/emailInboxApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/emailInboxApi')>(),
  emailInboxApi: api,
}))

const DEPLOYED: EmailInboxStatus = normalizeEmailInbox({
  enabled: true,
  domain: 'voc.example.com',
  addresses: ['feedback@voc.example.com', 'bugs@voc.example.com'],
  rule_set: 'own-set',
  rule_set_needs_activation: true,
  today: { accepted: 4, dropped: { spam: 2 }, deduped: { no_new_info: 1 } },
})

describe('EmailInboxCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.isAdmin = true
    api.get.mockResolvedValue(DEPLOYED)
    api.saveCaps.mockImplementation(async (caps) => ({ ...DEPLOYED, caps }))
    api.createFeedbackTypeDimension.mockResolvedValue({ success: true, created: true })
  })

  it('renders nothing for a non-admin', () => {
    auth.isAdmin = false
    const { container } = renderWithQueryClient(<EmailInboxCard />)
    expect(container).toBeEmptyDOMElement()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('says how to deploy when the inbox is off', async () => {
    api.get.mockResolvedValue(DEFAULT_EMAIL_INBOX)
    renderWithQueryClient(<EmailInboxCard />)
    expect(await screen.findByText(/inboundEmailDomain/)).toBeInTheDocument()
    expect(screen.getByText('Off')).toBeInTheDocument()
  })

  it('lists the addresses, warns about an inactive rule set and shows the redaction policy', async () => {
    renderWithQueryClient(<EmailInboxCard />)
    expect(await screen.findByText('feedback@voc.example.com')).toBeInTheDocument()
    expect(screen.getByText(/own-set is not active/)).toBeInTheDocument()
    expect(screen.getByText(/Personal data is redacted/)).toBeInTheDocument()
  })

  it("shows today's counters with the non-zero reasons", async () => {
    renderWithQueryClient(<EmailInboxCard />)
    expect(await screen.findByText('Spam verdict: 2')).toBeInTheDocument()
    expect(screen.getByText('Reply without new information: 1')).toBeInTheDocument()
    expect(screen.queryByText(/Virus verdict/)).not.toBeInTheDocument()
  })

  it('saves edited caps', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<EmailInboxCard />)
    const field = await screen.findByLabelText('Emails per sender per day')
    await user.clear(field)
    await user.type(field, '5')
    await user.click(screen.getByRole('button', { name: 'Save limits' }))
    await waitFor(() => expect(api.saveCaps).toHaveBeenCalledWith({ daily_cap: 200, sender_daily_cap: 5, daily_model_calls: 400 }))
    expect(await screen.findByText('Limits saved')).toBeInTheDocument()
  })

  it('refuses an out-of-range cap before calling the API', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<EmailInboxCard />)
    const field = await screen.findByLabelText('Emails per day')
    await user.clear(field)
    await user.type(field, '0')
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled()
  })

  it('creates the feedback_type dimension on request', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<EmailInboxCard />)
    await user.click(await screen.findByRole('button', { name: 'Create dimension' }))
    await waitFor(() => expect(api.createFeedbackTypeDimension).toHaveBeenCalledTimes(1))
  })

  it('reports a load failure', async () => {
    api.get.mockRejectedValue(new Error('boom'))
    renderWithQueryClient(<EmailInboxCard />)
    expect(await screen.findByText('The email inbox status could not be loaded.')).toBeInTheDocument()
  })
})

describe('normalizeEmailInbox', () => {
  it('reads anything malformed as an inbox that is off with zero counters', () => {
    const status = normalizeEmailInbox({ enabled: 'yes', today: { accepted: -1, dropped: 'x' }, pii: 'nope' })
    expect(status.enabled).toBe(false)
    expect(status.today.accepted).toBe(0)
    expect(status.today.dropped.spam).toBe(0)
    expect(status.pii).toBe('redact')
  })
})
