/**
 * Saving a review page from its form (live findings, 7.44.00): a name the server refuses ("Acme (EU)") got a raw 400,
 * so the form now says which characters a name may hold and never sends one it refuses; and a NEW page was sent
 * without `mode: 'create'`, so a URL the workspace already reads was stored as a second page while the API and the
 * assistant answer 409. A new page is now a create, an edit stays the upsert, and the 409 says which page it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createQueryWrapper } from '../Categories/categories-fixtures'
import PluginConfigModal from './PluginConfigModal'
import { isWebPageName } from './webPageName'
import { ApiError } from '../../lib/errors'
import type { PluginManifest } from '../../plugins/types'

type Rules = { mode?: string } | undefined
const mockSaveAppConfig = vi.fn<(source: string, app: Record<string, string>, rules: Rules) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: () => Promise.resolve({ apps: STORED }),
    saveAppConfig: (source: string, app: Record<string, string>, rules?: Rules) => mockSaveAppConfig(source, app, rules),
    getSourcesStatus: () => Promise.resolve({ sources: {} }),
  },
}))
vi.mock('../../store/configStore', () => ({ useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }) }))

const PAGE_URL = 'https://www.trustpilot.com/review/acme.example'
const STORED = [{ id: 'w1', app_name: 'Trustpilot - Acme', url: PAGE_URL }]
const webPlugin: PluginManifest = {
  id: 'web_reviews', name: 'Web Reviews', icon: 'Web', description: 'Review pages', enabled: true,
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false,
  config: [
    { key: 'app_name', label: 'Name', type: 'text', required: true, placeholder: 'Trustpilot - Example', secret: false },
    { key: 'url', label: 'Review page URL (https)', type: 'text', required: true, placeholder: 'https://', secret: false },
  ],
}

const HINT = 'Up to 100 letters, digits, spaces, “.”, “_” or “-”, starting with a letter A–Z or a digit.'

/** The dialog with its pages listed and the add form open. */
async function openAddForm() {
  const user = userEvent.setup()
  render(<PluginConfigModal plugin={webPlugin} onClose={vi.fn()} isAdmin />, { wrapper: createQueryWrapper() })
  await screen.findByText('Trustpilot - Acme')
  await user.click(screen.getByRole('button', { name: 'Add page' }))
  return user
}

const nameField = () => screen.getByRole('textbox', { name: /^Name/ })
const addButton = () => screen.getByRole('button', { name: /^Add page$/ })

async function fillPage(user: ReturnType<typeof userEvent.setup>, name: string, url: string) {
  await user.type(nameField(), name)
  await user.type(screen.getByRole('textbox', { name: /Review page URL/ }), url)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSaveAppConfig.mockResolvedValue({ success: true, app: {} })
})

describe("a review page's name", () => {
  it('says which characters it may hold, under its field', async () => {
    await openAddForm()
    expect(nameField()).toHaveAccessibleDescription(HINT)
  })

  it('refuses a name the server refuses before it is sent, and says why', async () => {
    const user = await openAddForm()
    await fillPage(user, 'Acme (EU)', 'https://www.g2.com/products/acme/reviews')

    expect(screen.getByRole('alert')).toHaveTextContent('This name cannot be saved')
    expect([nameField().getAttribute('aria-invalid'), addButton().hasAttribute('disabled')]).toStrictEqual(['true', true])
    await user.click(addButton())
    expect(mockSaveAppConfig).not.toHaveBeenCalled()
  })

  it('lets the name be saved once it is fixed', async () => {
    const user = await openAddForm()
    await fillPage(user, 'Acme (EU)', 'https://www.g2.com/products/acme/reviews')
    await user.clear(nameField())
    await user.type(nameField(), 'Acme EU')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(addButton()).toBeEnabled()
  })

  it.each([
    ['Trustpilot - Acme', true], ['Café_Ünited 2.0', true], [' padded ', true], ['a'.repeat(100), true],
    ['Acme (EU)', false], ['_acme', false], ['Éclair', false], ['a'.repeat(101), false], ['Acme/EU', false],
  ])('mirrors the server rule: %s → %s', (name, allowed) => {
    expect(isWebPageName(name)).toBe(allowed)
  })
})

describe('saving a new review page', () => {
  it("is a create: sent with mode 'create'", async () => {
    const user = await openAddForm()
    await fillPage(user, 'G2 - Acme', 'https://www.g2.com/products/acme/reviews')
    await user.click(addButton())

    await waitFor(() => expect(mockSaveAppConfig).toHaveBeenCalledTimes(1))
    expect(mockSaveAppConfig.mock.calls[0]).toStrictEqual(['web_reviews',
      { app_name: 'G2 - Acme', url: 'https://www.g2.com/products/acme/reviews' }, { mode: 'create' }])
  })

  it('says which page it already is when the server refuses it (409), and keeps the form', async () => {
    mockSaveAppConfig.mockRejectedValue(new ApiError(409, 'The review page "Trustpilot - Acme" already exists'))
    const user = await openAddForm()
    await fillPage(user, 'Acme again', `${PAGE_URL.toUpperCase().replace('HTTPS', 'https')} `)
    await user.click(addButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('This page is already a source: Trustpilot - Acme')
    expect(nameField()).toHaveValue('Acme again')
  })

  it("says the server's reason for any other refusal", async () => {
    mockSaveAppConfig.mockRejectedValue(new ApiError(400, 'url must be https'))
    const user = await openAddForm()
    await fillPage(user, 'Forum', 'https://forum.example/acme')
    await user.click(addButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('url must be https')
  })
})

describe('the control: saving an edit', () => {
  it('stays the upsert (no mode)', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={webPlugin} onClose={vi.fn()} isAdmin focusAppId="w1" />, { wrapper: createQueryWrapper() })
    const field = await screen.findByDisplayValue('Trustpilot - Acme')
    await user.type(field, ' EU')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockSaveAppConfig).toHaveBeenCalledTimes(1))
    expect(mockSaveAppConfig.mock.calls[0]?.[2]).toBeUndefined()
  })
})
