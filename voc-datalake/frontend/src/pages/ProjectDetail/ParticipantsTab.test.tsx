/**
 * @fileoverview Project → Participants: linked lists and people with the reach, link / invite /
 * remove for editors only, "Ask for feedback" prefilled with the project and everyone linked,
 * and this project's asks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ANA, LIST_BETA, participantRoutes } from '../Participants/participants-fixtures'
import ParticipantsTab from './ParticipantsTab'
import { parsedJson } from '@test/jsonText'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const PROJECT = { lists: [LIST_BETA], people: [ANA], reach: 2 }

const callsTo = (method: string, endpoint: string) =>
  fetchApi.mock.calls.filter(([path, options]) => path === endpoint && (options?.method ?? 'GET') === method)

beforeEach(() => {
  resetFetchApi()
  routeFetchApi(participantRoutes({
    'GET /participants/projects/proj_1': () => PROJECT,
    'POST /participants/projects/proj_1': () => PROJECT,
    'DELETE /participants/projects/proj_1/lists/lst_beta': () => ({ success: true }),
  }), { ignoreQuery: true })
})

describe('the project Participants tab', () => {
  it('shows the linked lists and people and how many active people they reach', async () => {
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    expect(await screen.findByText('Reaches 2 active people.')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Linked lists' })).getByText('Acme beta customers')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Linked people' })).getByText('Ana Lopez')).toBeInTheDocument()
  })

  it('lists this project’s asks only', async () => {
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    expect(await screen.findByText('Tell us about the booking flow')).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/participants/asks?project_id=proj_1', undefined)
  })

  it('links another list to the project', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    const select = await screen.findByRole('combobox', { name: /add a list/i })
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Example Air employees' })).toBeInTheDocument())
    await user.selectOptions(select, 'lst_staff')
    await user.click(screen.getByRole('button', { name: /link list/i }))
    await waitFor(() => expect(callsTo('POST', '/participants/projects/proj_1')).toHaveLength(1))
    expect(parsedJson(callsTo('POST', '/participants/projects/proj_1')[0]?.[1]?.body)).toStrictEqual({ list_ids: ['lst_staff'] })
  })

  it('invites a new person by email', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    await user.type(await screen.findByRole('textbox', { name: /email/i }), 'new.person@example.com')
    await user.click(screen.getByRole('button', { name: /^invite$/i }))
    await waitFor(() => expect(callsTo('POST', '/participants/projects/proj_1')).toHaveLength(1))
    expect(parsedJson(callsTo('POST', '/participants/projects/proj_1')[0]?.[1]?.body)).toStrictEqual({ people: [{ email: 'new.person@example.com' }] })
  })

  it('says why a new address was refused (the API answers 200 with `rejected`)', async () => {
    routeFetchApi(participantRoutes({
      'GET /participants/projects/proj_1': () => PROJECT,
      'POST /participants/projects/proj_1': () => ({
        ...PROJECT, created: 0, rejected: [{ email: 'eve@elsewhere.example', reason: 'external_not_allowed' }],
      }),
    }), { ignoreQuery: true })
    const user = userEvent.setup()
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    const email = await screen.findByRole('textbox', { name: /email/i })
    await user.type(email, 'eve@elsewhere.example')
    await user.click(screen.getByRole('button', { name: /^invite$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^eve@elsewhere\.example: /)
    expect(email).toHaveValue('eve@elsewhere.example')
  })

  it('removes a linked list', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    await user.click(await screen.findByRole('button', { name: /remove the list acme beta customers/i }))
    await waitFor(() => expect(callsTo('DELETE', '/participants/projects/proj_1/lists/lst_beta')).toHaveLength(1))
  })

  it('opens the composer prefilled with the project’s lists and people', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit />)
    await user.click(await screen.findByRole('button', { name: /ask for feedback/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('checkbox', { name: /acme beta customers/i })).toBeChecked()
    expect(within(dialog).getByRole('button', { name: /remove ana lopez/i })).toBeInTheDocument()
  })

  it('is read-only for a viewer: no add, remove or ask', async () => {
    renderWithQueryClient(<ParticipantsTab projectId="proj_1" canEdit={false} />)
    await screen.findByText('Reaches 2 active people.')
    expect(screen.queryByRole('button', { name: /ask for feedback/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /add participants/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove the list/i })).not.toBeInTheDocument()
  })
})
