/**
 * Administration → Engineering agents (7.59.00, EngineeringAgentsTab.tsx): the hard cap (Agents › Spend's card), each
 * role's harness and model from the Registry's own read, linked to its Registry card, and the links to Connections,
 * Spend and the setup guide; each card an anchor a link may name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { tokenConnection } from '@test/tokenConnectionFixtures'
import { useConfigStore } from '../../store/configStore'
import { parseRegistry } from '../../api/engineeringRegistryApi'
import type { RegistryCard } from '../../api/engineeringRegistryApi'

const list = vi.fn<(connection: string) => Promise<RegistryCard[]>>()
vi.mock('../../api/engineeringRegistryApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/engineeringRegistryApi')>(),
  engineeringRegistryApi: { list: (connection: string) => list(connection) },
}))
vi.mock('../Agents/EngineeringHardCap', () => ({ EngineeringHardCap: () => <p data-testid="hard-cap">Hard cap</p> }))
const listConnections = vi.fn<() => Promise<unknown>>()
vi.mock('../../api/engineeringConnectionsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/engineeringConnectionsApi')>(),
  engineeringConnectionsApi: { list: () => listConnections() },
}))

const { default: EngineeringAgentsTab } = await import('./EngineeringAgentsTab')

/** A card as the Registry's parser reads it (its defaults for every field the tab does not read). */
function card(over: Record<string, unknown>): RegistryCard {
  const [parsed] = parseRegistry({ cards: [{ kind: 'role', id: 'fixer', base_role: 'fixer', title: 'Fixer',
    model: 'global.anthropic.claude-sonnet-5-5', model_choice: null, runs_on: 'native', skill: {}, ...over }] })
  if (parsed === undefined) throw new Error('unreadable card')
  return parsed
}

/** The list item that names `text`. */
const rowOf = (text: string) => screen.getByText(text).closest('li')

const renderTab = () => renderWithQueryClient(<TestRouter initialEntries={['/admin/agents']}><EngineeringAgentsTab /></TestRouter>)

beforeEach(() => {
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com' } }))
  list.mockReset()
  listConnections.mockReset()
  listConnections.mockResolvedValue({ connections: [], limit: 50 })
})

describe("the roles' models", () => {
  it('lists each role (no made card) with its harness and model, linked to its Registry card', async () => {
    list.mockResolvedValue([
      card({}),
      card({ id: 'coordinator', base_role: 'coordinator', runs_on: 'kiro', model_choice: 'auto' }),
      card({ kind: 'card', id: 'crd_1', title: 'My fixer', model_choice: 'opus' }),
    ])
    renderTab()
    await screen.findByText('Fixer')
    expect([rowOf('Fixer')?.textContent, rowOf('Run coordinator')?.textContent]).toStrictEqual([
      expect.stringMatching(/^Fixernative.*Role default \(.+\)Change$/), 'Run coordinatorKiroAutoChange',
    ])
    expect(screen.getByRole('link', { name: 'Change the model of Fixer' })).toHaveAttribute('href', '/agents/registry/fixer')
    expect([screen.queryByText('My fixer'), list.mock.calls[0]]).toStrictEqual([null, ['']])
  })

  it('says when the roles cannot be read, with a retry', async () => {
    list.mockRejectedValue(new Error('boom'))
    renderTab()
    const user = userEvent.setup()
    expect(await screen.findByText("Couldn't read the roles' models.")).toBeInTheDocument()
    list.mockResolvedValue([card({})])
    await user.click(screen.getByRole('button', { name: /retry|try again/i }))
    expect(await screen.findByText('Fixer')).toBeInTheDocument()
  })
})

describe('the rest of the tab', () => {
  it('holds the hard cap and the links to Connections, Spend and the setup guide, each card an anchor', () => {
    list.mockResolvedValue([])
    renderTab()
    expect(screen.getByTestId('hard-cap')).toBeInTheDocument()
    const links = ['Agent orchestration › Connections', 'Agent orchestration › Spend', 'Setup guide']
    expect(links.map((name) => screen.getByRole('link', { name }).getAttribute('href'))).toStrictEqual(['/agents/connections', '/agents/spend', '/agents/setup'])
    expect(['hard-cap', 'models', 'connections'].map((id) => document.getElementById(`admin-card-${id}`)?.tabIndex)).toStrictEqual([-1, -1, -1])
  })
})

describe('the fine-grained tokens to replace (7.60.00)', () => {
  it('lists each one with its chip, or that it cannot be used, and nothing for a token that is fine', async () => {
    list.mockResolvedValue([])
    listConnections.mockResolvedValue({ limit: 50, connections: [
      tokenConnection('c-soon', 'partner-org/sdk', 3), tokenConnection('c-fine', 'partner-org/docs', 60),
      tokenConnection('c-gone', 'partner-org/cli', 0), tokenConnection('c-unset', 'partner-org/api', 30, { set: false }),
    ] })
    renderTab()
    const box = await screen.findByTestId('tokens-to-replace')
    expect(within(box).getByRole('heading', { name: 'Fine-grained tokens to replace' })).toBeInTheDocument()
    expect(within(box).getAllByRole('listitem').map((row) => row.textContent)).toStrictEqual([
      'partner-org/sdkExpires in 3 days', 'partner-org/cliToken expired', 'partner-org/apiNot set, or its expiry is not known',
    ])
  })

  it('shows nothing while every token is fine', async () => {
    list.mockResolvedValue([])
    listConnections.mockResolvedValue({ limit: 50, connections: [tokenConnection('c-fine', 'partner-org/docs', 60)] })
    renderTab()
    await waitFor(() => { expect(listConnections).toHaveBeenCalledWith() })
    expect(screen.queryByTestId('tokens-to-replace')).not.toBeInTheDocument()
  })
})
