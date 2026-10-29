/**
 * @fileoverview Administration → Users → "Participant email": the stored settings, the read-only
 * company domains (edited in Boards, linked), the read-only email and board lines, and an
 * admin-only partial save that never sends the domains.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { asRecord } from '../../api/wireRecord'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { SETTINGS_VIEW } from '../Participants/participants-fixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: ParticipantSettingsCard } = await import('./ParticipantSettingsCard')

const renderCard = () => renderWithQueryClient(<TestRouter><ParticipantSettingsCard /></TestRouter>)

const saves = () => fetchApi.mock.calls.filter(([path, options]) => path === '/participants/settings' && options?.method === 'PUT')

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  routeFetchApi({
    'GET /participants/settings': () => SETTINGS_VIEW,
    'PUT /participants/settings': (body) => ({ settings: { ...SETTINGS_VIEW.settings, ...asRecord(body) } }),
  })
})

describe('the participant settings card', () => {
  it('shows whether email is configured and the board link', async () => {
    renderCard()
    expect(await screen.findByText('configured')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://voc.example.com/board' })).toBeInTheDocument()
  })

  it('says email is not configured and the board is not deployed when the server says so', async () => {
    routeFetchApi({ 'GET /participants/settings': () => ({ ...SETTINGS_VIEW, email_enabled: false, board_enabled: false }) })
    renderCard()
    expect(await screen.findByText(/not configured \(deploy with an email sender address\)/)).toBeInTheDocument()
    expect(screen.getByText('not deployed')).toBeInTheDocument()
  })

  it('shows the company domains read-only and links to Boards to edit them', async () => {
    renderCard()
    expect(await screen.findByText(/Company domains: example\.com\./)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /company email domains/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit them in Boards' })).toHaveAttribute('href', '/admin?tab=access&section=boards')
  })

  it('saves the external-people switch, the cap and the sender name, never the domains', async () => {
    const user = userEvent.setup()
    renderCard()
    await user.click(await screen.findByRole('switch', { name: /allow participants outside/i }))
    const cap = screen.getByRole('spinbutton', { name: /daily send limit/i })
    await user.clear(cap)
    await user.type(cap, '200')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(JSON.parse(String(saves()[0]?.[1]?.body))).toStrictEqual({
      allow_external_people: false, daily_send_cap: 200, sender_name: 'Example Air',
    })
  })

  it('says "Saved." after a save that changes the stored version (the form reloads with it)', async () => {
    const user = userEvent.setup()
    const stored = new Map([['view', SETTINGS_VIEW]])
    routeFetchApi({
      'GET /participants/settings': () => stored.get('view'),
      'PUT /participants/settings': (body) => {
        const settings = { ...SETTINGS_VIEW.settings, ...asRecord(body), updated_at: '2026-10-26T00:00:00Z' }
        stored.set('view', { ...SETTINGS_VIEW, settings })
        return { settings }
      },
    })
    renderCard()
    await user.clear(await screen.findByRole('textbox', { name: /sender name/i }))
    await user.type(screen.getByRole('textbox', { name: /sender name/i }), 'Acme')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /sender name/i })).toHaveDisplayValue('Acme')
  })

  it('will not save a cap outside 1 to 5000', async () => {
    const user = userEvent.setup()
    renderCard()
    const cap = await screen.findByRole('spinbutton', { name: /daily send limit/i })
    await user.clear(cap)
    await user.type(cap, '9000')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('will not save an empty sender name (the API refuses it)', async () => {
    const user = userEvent.setup()
    renderCard()
    const sender = await screen.findByRole('textbox', { name: /sender name/i })
    await user.clear(sender)
    await user.type(sender, '   ')
    expect(sender).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('is read-only for a non-admin', async () => {
    adminFlag.isAdmin = false
    renderCard()
    expect(await screen.findByRole('textbox', { name: /sender name/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })
})
