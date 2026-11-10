/**
 * @fileoverview Administration → System → Logs → Alerts card: admin-only, switch on/off,
 * recipients with their confirmation state, and refusals shown in words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { ApiError } from '../../lib/errors'
import type { AlertsStatus } from '../../api/alertsApi'
import AlertsCard from './AlertsCard'

const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => auth.isAdmin }))

const api = vi.hoisted(() => ({
  get: vi.fn<() => Promise<AlertsStatus>>(),
  setEnabled: vi.fn<(enabled: boolean) => Promise<unknown>>(),
  addRecipient: vi.fn<(email: string) => Promise<unknown>>(),
  removeRecipient: vi.fn<(email: string) => Promise<unknown>>(),
}))
vi.mock('../../api/alertsApi', () => ({ alertsApi: api, alertsKey: () => ['logs', 'alerts'] }))

function status(overrides: Partial<AlertsStatus> = {}): AlertsStatus {
  return {
    configured: true, enabled: false, alarms: [], expected_alarm_count: 9, billed_metric_count: 11,
    subscribers: [], max_subscribers: 10, ...overrides,
  }
}

describe('AlertsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.isAdmin = true
    api.get.mockResolvedValue(status())
    api.setEnabled.mockResolvedValue({ success: true })
    api.addRecipient.mockResolvedValue({ success: true })
    api.removeRecipient.mockResolvedValue({ success: true })
  })

  it('renders nothing and asks nothing for a non-admin', () => {
    auth.isAdmin = false
    const { container } = renderWithQueryClient(<AlertsCard />)
    expect(container).toBeEmptyDOMElement()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('shows alerting off with the alarm count and the monthly cost it would add', async () => {
    renderWithQueryClient(<AlertsCard />)
    const toggle = await screen.findByRole('switch', { name: /Email alerts/ })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText(/9 alarms, about US\$1\.10 per month/)).toBeInTheDocument()
  })

  it('turns alerting on through the API when the switch is flipped', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<AlertsCard />)
    await user.click(await screen.findByRole('switch', { name: /Email alerts/ }))
    expect(api.setEnabled).toHaveBeenCalledWith(true)
  })

  it('says next to an on switch that turning it off deletes the alarms', async () => {
    api.get.mockResolvedValue(status({ enabled: true, subscribers: [{ email: 'ops@example.com', status: 'confirmed' }] }))
    renderWithQueryClient(<AlertsCard />)
    expect(await screen.findByText(/Turning alerts off deletes the alarms/)).toBeInTheDocument()
  })

  it('warns when alerting is on but no recipient has confirmed', async () => {
    api.get.mockResolvedValue(status({ enabled: true, subscribers: [{ email: 'ops@example.com', status: 'pending' }] }))
    renderWithQueryClient(<AlertsCard />)
    expect(await screen.findByText(/nobody is notified/)).toBeInTheDocument()
    expect(screen.getByText('Pending confirmation')).toBeInTheDocument()
  })

  it('lists confirmed and pending recipients and removes one', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(status({ subscribers: [
      { email: 'a@example.com', status: 'confirmed' }, { email: 'b@example.com', status: 'pending' },
    ] }))
    renderWithQueryClient(<AlertsCard />)
    expect(await screen.findByText('Confirmed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove b@example.com' }))
    expect(api.removeRecipient).toHaveBeenCalledWith('b@example.com')
  })

  it('adds a trimmed address and clears the field', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<AlertsCard />)
    const input = await screen.findByLabelText('Email address')
    await user.type(input, '  ops@example.com ')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(api.addRecipient).toHaveBeenCalledWith('ops@example.com')
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('explains a 409 on removing a recipient that has not confirmed', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(status({ subscribers: [{ email: 'b@example.com', status: 'pending' }] }))
    api.removeRecipient.mockRejectedValue(new ApiError(409, 'pending'))
    renderWithQueryClient(<AlertsCard />)
    await user.click(await screen.findByRole('button', { name: 'Remove b@example.com' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/has not confirmed yet/)
  })

  it('disables adding at the recipient limit', async () => {
    api.get.mockResolvedValue(status({
      max_subscribers: 1, subscribers: [{ email: 'a@example.com', status: 'confirmed' }],
    }))
    renderWithQueryClient(<AlertsCard />)
    expect(await screen.findByLabelText('Email address')).toBeDisabled()
    expect(screen.getByText('Limit reached (1 recipients).')).toBeInTheDocument()
  })

  it('says so when the deployment has no alert targets', async () => {
    api.get.mockResolvedValue(status({ configured: false }))
    renderWithQueryClient(<AlertsCard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Alerting is not available on this deployment.')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
