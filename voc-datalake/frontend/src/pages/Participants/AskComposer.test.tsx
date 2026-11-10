/**
 * @fileoverview The "New ask" composer: the recipient count across lists, the draft's problems
 * named before anything is sent, Send disabled while email sending is off, the server's 429 and
 * 409 said in a sentence, and the request body of a good ask.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import AskComposer from './AskComposer'
import { SEED_ASK, SETTINGS_VIEW, participantRoutes } from './participants-fixtures'
import { parsedJson } from '@test/jsonText'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

function route(overrides: Record<string, RouteHandler> = {}) {
  routeFetchApi(participantRoutes(overrides), { ignoreQuery: true })
}

const asksPosted = () => fetchApi.mock.calls.filter(([path, options]) => path === '/participants/asks' && options?.method === 'POST')

async function fillMessage(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Booking flow')
  await user.type(screen.getByRole('textbox', { name: /message/i }), 'Two minutes, please.')
  await user.selectOptions(await screen.findByRole('combobox'), 'form_1')
}

beforeEach(() => {
  resetFetchApi()
})

describe('the ask composer', () => {
  it('counts the distinct people across the chosen lists and says unsubscribed people are skipped', async () => {
    const user = userEvent.setup()
    route()
    renderWithQueryClient(<AskComposer onClose={vi.fn()} />)
    await user.click(await screen.findByRole('checkbox', { name: /example air employees/i }))
    await user.click(screen.getByRole('checkbox', { name: /acme beta customers/i }))
    expect(await screen.findByText('2 people')).toBeInTheDocument()
    expect(screen.getByText('Unsubscribed people are skipped.')).toBeInTheDocument()
  })

  it('names what is missing instead of sending an incomplete ask', async () => {
    const user = userEvent.setup()
    route()
    renderWithQueryClient(<AskComposer onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /^send$/i }))
    expect(screen.getByText('Choose at least one list or person.')).toBeInTheDocument()
    expect(screen.getByText('Write a subject.')).toBeInTheDocument()
    expect(screen.getByText('Choose a feedback form.')).toBeInTheDocument()
    expect(asksPosted()).toHaveLength(0)
  })

  it('refuses a web page link that is not https', async () => {
    const user = userEvent.setup()
    route()
    renderWithQueryClient(<AskComposer initialListIds={['lst_staff']} onClose={vi.fn()} />)
    await user.click(screen.getByRole('radio', { name: /a web page/i }))
    await user.type(screen.getByRole('textbox', { name: /a web page/i }), 'http://example.com')
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(screen.getByText(/starts with https:\/\//)).toBeInTheDocument()
  })

  it('disables Send and explains why when email sending is not configured', async () => {
    route({ 'GET /participants/settings': () => ({ ...SETTINGS_VIEW, email_enabled: false }) })
    renderWithQueryClient(<AskComposer onClose={vi.fn()} />)
    expect(await screen.findByText(/email sending is not configured for this deployment, so asks cannot be sent/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled()
  })

  it('says the daily limit was reached when the server answers 429', async () => {
    const user = userEvent.setup()
    route({ 'POST /participants/asks': () => { throw new ApiError(429, 'daily_cap') } })
    renderWithQueryClient(<AskComposer initialListIds={['lst_staff']} onClose={vi.fn()} />)
    await fillMessage(user)
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText(/today's sending limit would be exceeded/i)).toBeInTheDocument()
  })

  it('says email is not configured when the server answers 409', async () => {
    const user = userEvent.setup()
    route({ 'POST /participants/asks': () => { throw new ApiError(409, 'email_not_configured') } })
    renderWithQueryClient(<AskComposer initialListIds={['lst_staff']} onClose={vi.fn()} />)
    await fillMessage(user)
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText('Email sending is not configured for this deployment.')).toBeInTheDocument()
  })

  it('sends the project, the recipients and the form link, then confirms', async () => {
    const user = userEvent.setup()
    route({ 'POST /participants/asks': () => ({ ask: SEED_ASK }) })
    renderWithQueryClient(<AskComposer projectId="proj_1" initialListIds={['lst_staff']} initialPersonIds={['per_dev']} onClose={vi.fn()} />)
    await fillMessage(user)
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText('Your ask is on its way to 3 people.')).toBeInTheDocument()
    await waitFor(() => expect(asksPosted()).toHaveLength(1))
    expect(parsedJson(asksPosted()[0]?.[1]?.body)).toStrictEqual({
      project_id: 'proj_1', list_ids: ['lst_staff'], person_ids: ['per_dev'], subject: 'Booking flow',
      message: 'Two minutes, please.', link: { kind: 'form', form_id: 'form_1' },
    })
  })
})
