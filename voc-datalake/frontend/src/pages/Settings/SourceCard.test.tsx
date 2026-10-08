import type { ComponentProps } from 'react'
/**
 * @fileoverview Tests for SourceCard component
 * @module pages/Settings/SourceCard.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import SourceCard from './SourceCard'
// Imported rather than restated: the subject of these assertions is the admin GATE,
// not the wording, so a later decision to translate the tooltip must not fail them.
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import type { PluginManifest, SetupInfo } from '../../plugins/types'
import { expectScheduleToggleLocked, sourceScheduleMocks } from '../Scrapers/scrapers-fixtures'

// Mock API
const mockGetIntegrationStatus = vi.fn<(...args: unknown[]) => unknown>()
const mockGetSourcesStatus = vi.fn<(...args: unknown[]) => unknown>()
const mockUpdateIntegrationCredentials = vi.fn<(...args: unknown[]) => unknown>()
const mockTestIntegration = vi.fn<(...args: unknown[]) => unknown>()
const { enableSource: mockEnableSource, disableSource: mockDisableSource } = sourceScheduleMocks

vi.mock('../../api/client', () => ({
  api: {
    getIntegrationStatus: () => mockGetIntegrationStatus(),
    getSourcesStatus: () => mockGetSourcesStatus(),
    updateIntegrationCredentials: (source: string, creds: Record<string, string>) =>
      mockUpdateIntegrationCredentials(source, creds),
    testIntegration: (source: string) => mockTestIntegration(source),
    enableSource: (source: string) => sourceScheduleMocks.enableSource(source),
    disableSource: (source: string) => sourceScheduleMocks.disableSource(source),
  },
}))

// Mock S3ImportExplorer
vi.mock('../../components/S3ImportExplorer/S3ImportExplorer', () => ({
  default: () => <div data-testid="s3-import-explorer">S3 Import Explorer</div>,
}))

const MOCK_SETUP: SetupInfo = {
  title: 'Setup Instructions',
  color: 'blue',
  steps: ['Step 1', 'Step 2', 'Step 3'],
}

const mockManifest: PluginManifest = {
  id: 'test_source',
  name: 'Test Source',
  icon: 'Synthetic',
  enabled: true,
  description: 'Test source description',
  config: [
    { key: 'api_key', label: 'API Key', type: 'password', required: true, secret: true },
    { key: 'business_id', label: 'Business ID', type: 'text', placeholder: 'Enter ID', required: false, secret: false },
  ],
  webhooks: [
    { name: 'Test Webhook', events: ['created', 'updated'], docUrl: 'https://docs.example.com' },
  ],
  setup: MOCK_SETUP,
  hasIngestor: true,
  hasWebhook: true,
  hasS3Trigger: false,
}


type SourceCardProps = ComponentProps<typeof SourceCard>

/** Renders the card for an admin against the default endpoint; `overrides` replace any prop. */
function renderCard(overrides: Partial<SourceCardProps> = {}) {
  return renderWithQueryClient(<SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" isAdmin {...overrides} />)
}

/** `renderCard`, then opens the card by its header (named after the manifest). */
async function renderExpanded(overrides: Partial<SourceCardProps> = {}, header: RegExp = /test source/i) {
  const user = userEvent.setup()
  renderCard(overrides)
  await user.click(screen.getByRole('button', { name: header }))
  return user
}

/** Opens the card (as admin, save succeeding), types `apiKey` and clicks Save. */
async function saveApiKey(apiKey: string) {
  mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })
  const user = await renderExpanded()
  await user.type(screen.getByPlaceholderText('Enter api key'), apiKey)
  await user.click(screen.getByRole('button', { name: /save/i }))
}

describe('SourceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: false } })
    mockGetSourcesStatus.mockResolvedValue({ sources: { test_source: { enabled: false } } })
  })

  describe('Header', () => {
    it('renders source name and icon', () => {
      renderCard()

      expect(screen.getByText('Test Source')).toBeInTheDocument()
      // Known manifest icons render as a lucide glyph inside the icon tile, not as raw emoji.
      const tile = screen.getByTestId('source-icon')
      expect(tile.querySelector('svg')).not.toBeNull()
    })

    it('renders a fallback icon, never the raw manifest string, for an unknown icon word', () => {
      renderCard({ manifest: { ...mockManifest, icon: 'Satellite' } })

      const tile = screen.getByTestId('source-icon')
      expect(tile).toHaveTextContent('')
      expect(tile.querySelector('svg')).not.toBeNull()
    })

    it('names the enable switch after the source and exposes the expand state', async () => {
      const user = userEvent.setup()
      renderCard()

      expect(screen.getByRole('checkbox', { name: /Test Source Disabled/i })).toBeInTheDocument()
      const expand = screen.getByRole('button', { name: /test source/i })
      expect(expand).toHaveAttribute('aria-expanded', 'false')
      await user.click(expand)
      expect(expand).toHaveAttribute('aria-expanded', 'true')
    })

    it('renders description when provided', () => {
      renderCard()

      expect(screen.getByText('Test source description')).toBeInTheDocument()
    })

    it('shows connected badge when source is configured', async () => {
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })

      renderCard()

      await waitFor(() => {
        expect(screen.getByText('Connected')).toBeInTheDocument()
      })
    })

    it('shows enabled/disabled toggle', () => {
      renderCard()

      expect(screen.getByRole('checkbox')).toBeInTheDocument()
      expect(screen.getByText('Disabled')).toBeInTheDocument()
    })

    it('does not call getIntegrationStatus when isAdmin is false', async () => {
      renderCard({ isAdmin: false })

      // Give the query time to fire if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(mockGetIntegrationStatus).not.toHaveBeenCalled()
    })
  })

  describe('Expand/Collapse', () => {
    it('expands card when header is clicked', async () => {
      await renderExpanded()

      expect(screen.getByText('API Credentials')).toBeInTheDocument()
    })

    it('shows webhooks section when expanded', async () => {
      await renderExpanded()

      expect(screen.getByText('Webhooks')).toBeInTheDocument()
      expect(screen.getByText('Test Webhook')).toBeInTheDocument()
    })

    it('shows setup instructions when expanded', async () => {
      await renderExpanded()

      expect(screen.getByText('Setup Instructions')).toBeInTheDocument()
      expect(screen.getByText('Step 1')).toBeInTheDocument()
    })
  })

  describe('Enable/Disable Toggle', () => {
    it('enables source when toggle is clicked', async () => {
      const user = userEvent.setup()
      mockEnableSource.mockResolvedValue({ enabled: true })

      renderCard()

      await user.click(screen.getByRole('checkbox'))

      await waitFor(() => {
        expect(mockEnableSource).toHaveBeenCalledWith('test_source')
      })
    })

    it('disables source when toggle is unchecked', async () => {
      const user = userEvent.setup()
      mockGetSourcesStatus.mockResolvedValue({ sources: { test_source: { enabled: true } } })
      mockDisableSource.mockResolvedValue({ enabled: false })

      renderCard()

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeChecked()
      })

      await user.click(screen.getByRole('checkbox'))

      await waitFor(() => {
        expect(mockDisableSource).toHaveBeenCalledWith('test_source')
      })
    })

    it('disables toggle when no API endpoint', () => {
      renderCard({ apiEndpoint: '' })

      expect(screen.getByRole('checkbox')).toBeDisabled()
    })

    /**
     * The Enabled toggle calls `PUT /sources/{source}/enable|disable`, which is
     * admin-gated server-side. It shipped enabled for a non-admin: rendered with
     * `isAdmin={false}` the checkbox was not disabled and one click issued one
     * `enableSource` call, whose 403 `toggleEnabled`'s empty `catch` swallows — so
     * the checkbox silently reverted with no message.
     *
     * This is the only UI entrance to those two routes outside the Scrapers modal.
     * The two cases assert the REQUEST is not issued, not merely that `disabled` is
     * present, matching `Scrapers/AppConfigComponents.test.tsx`; the surrounding
     * `isAdmin={true}` cases above are the positive control, so disabling the toggle
     * for everyone cannot pass.
     */
    describe('when the user is not an admin', () => {
      it('disables the toggle and issues no request when it is clicked', async () => {
        const user = userEvent.setup()

        renderCard({ isAdmin: false })

        // The observable that matters: no 403 was provoked.
        await expectScheduleToggleLocked(user)
      })

      it('explains why the toggle is disabled', () => {
        renderCard({ isAdmin: false })

        // On the label, not the input: a disabled input does not reliably surface
        // its own title on hover.
        expect(screen.getByTitle(ADMIN_ONLY_TITLE)).toBeInTheDocument()
      })

      it('leaves the toggle untitled for an admin', () => {
        /** Non-vacuity for the case above: a title rendered unconditionally would
         *  satisfy it while telling an admin their access is refused. */
        renderCard()

        expect(screen.queryByTitle(ADMIN_ONLY_TITLE)).not.toBeInTheDocument()
      })
    })
  })

  describe('Credentials Section', () => {
    it('renders credential fields', async () => {
      await renderExpanded()

      expect(screen.getByText('API Key')).toBeInTheDocument()
      expect(screen.getByText('Business ID')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter api key')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter ID')).toBeInTheDocument()
    })

    it('toggles password visibility', async () => {
      const user = await renderExpanded()

      const apiKeyInput = screen.getByPlaceholderText('Enter api key')
      expect(apiKeyInput).toHaveAttribute('type', 'password')

      await user.click(screen.getByRole('button', { name: /show/i }))

      expect(apiKeyInput).toHaveAttribute('type', 'text')
    })

    it('saves credentials when save button is clicked', async () => {
      await saveApiKey('secret-key')

      await waitFor(() => {
        expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith('test_source', { api_key: 'secret-key' })
      })
    })

    it('shows success message after saving', async () => {
      await saveApiKey('secret-key')

      // The Save button swaps its label for the confirmation.
      expect(await screen.findByRole('button', { name: /saved!/i })).toBeInTheDocument()
    })

    /**
     * `Save to Secrets Manager` calls `PUT /integrations/{source}/credentials`,
     * which `require_admin` gates server-side. Unlike the Enabled toggle above,
     * that route was ALREADY gated before this PR, so the button has always
     * behaved this way — measured before the fix, as a non-admin: `disabled` was
     * false, there was no `title`, one click issued 1 `updateIntegrationCredentials`
     * call, and because `updateCredentialsMutation` has an `onSuccess` but no
     * `onError` the 403 rendered nothing at all. The button simply never became
     * `Saved!`, so a non-admin typed a credential and got no indication it was
     * refused — the same silent-discard shape `ScraperEditor`'s Save had.
     *
     * This was the last ungated UI entrance to an admin-gated route.
     *
     * The first case asserts the REQUEST is not issued rather than only that
     * `disabled` is present, matching the toggle cases above and
     * `Scrapers/AppConfigComponents.test.tsx`. The `isAdmin={true}` cases above
     * ('saves credentials when save button is clicked') are its positive control,
     * so disabling Save for everyone cannot pass.
     */
    describe('when the user is not an admin', () => {
      /** Expand the card and enter a credential, so Save's only remaining
       *  disable reason is the admin gate — `Object.keys(credentials).length === 0`
       *  disables it on an untouched form regardless of who is looking. */
      async function expandAndType(user: ReturnType<typeof userEvent.setup>, isAdmin: boolean) {
        renderCard({ isAdmin })
        await user.click(screen.getByRole('button', { name: /test source/i }))
        await user.type(screen.getByPlaceholderText('Enter api key'), 'secret-key')
        return screen.getByRole('button', { name: /save/i })
      }

      it('disables save and issues no credential write when it is clicked', async () => {
        const user = userEvent.setup()
        const save = await expandAndType(user, false)

        expect(save).toBeDisabled()

        await user.click(save)

        // The observable that matters: no 403 was provoked, so there is no
        // silently-swallowed failure to present as success.
        expect(mockUpdateIntegrationCredentials).not.toHaveBeenCalled()
      })

      it('explains why save is disabled', async () => {
        const user = userEvent.setup()
        const save = await expandAndType(user, false)

        expect(save).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      })

      it('leaves save untitled for an admin', async () => {
        /** Non-vacuity for the case above: a title rendered unconditionally would
         *  satisfy it while telling an administrator their access is refused. */
        const user = userEvent.setup()
        const save = await expandAndType(user, true)

        expect(save).not.toHaveAttribute('title')
      })

      it('leaves the credential fields editable and gates only Save', async () => {
        /** The gate's BOUNDARY, not the gate. A non-admin can already read these
         *  fields — `GET /integrations/status` is what is admin-gated, not the
         *  form — so freezing them would hide state rather than protect it. And
         *  without this, "disable everything for a non-admin" would pass every
         *  case above.
         *
         *  Save is asserted to be the ONLY control carrying the admin-only
         *  reason, which is what pins the gate's extent. The `Test` button is
         *  deliberately not asserted as clickable here: `POST /integrations/
         *  {source}/test` is NOT admin-gated, but the button's `disabled` reads
         *  `sourceStatus?.configured`, which comes from the admin-only
         *  integration-status query — so it is already unreachable for a
         *  non-admin for a reason that predates and is independent of this gate.
         *  Asserting it enabled here would fail for that unrelated reason and
         *  misattribute it to the admin gate. */
        const user = userEvent.setup()
        mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
        await expandAndType(user, false)

        expect(screen.getByPlaceholderText('Enter api key')).toBeEnabled()
        expect(screen.getByPlaceholderText('Enter ID')).toBeEnabled()

        // Show/Hide is a local view toggle and stays usable.
        expect(screen.getByRole('button', { name: /show/i })).toBeEnabled()

        // Save is the only control in this section carrying the admin-only
        // reason — `Test` calls an ungated route and must not claim otherwise.
        expect(screen.getByRole('button', { name: /^test$/i })).not.toHaveAttribute('title')
      })
    })
  })

  describe('Test Integration', () => {
    it('tests integration when test button is clicked', async () => {
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: true, message: 'Connection successful' })

      const user = await renderExpanded()

      // Wait for the integration status to load
      await waitFor(() => {
        const testButton = screen.getByRole('button', { name: /test$/i })
        expect(testButton).not.toBeDisabled()
      })

      await user.click(screen.getByRole('button', { name: /test$/i }))

      await waitFor(() => {
        expect(mockTestIntegration).toHaveBeenCalledWith('test_source')
      })
    })

    it.each([
      ['shows success message on successful test', true, 'Connection successful'],
      ['shows error message on failed test', false, 'Invalid credentials'],
    ])('%s', async (_name, success, message) => {
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success, message })

      const user = await renderExpanded()
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test$/i })).toBeEnabled()
      })
      await user.click(screen.getByRole('button', { name: /test$/i }))

      expect(await screen.findByText(message)).toBeInTheDocument()
    })

    it('disables test button when source not configured', async () => {
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: false } })

      await renderExpanded()

      // The test button should be disabled when not configured
      const testButton = screen.getByRole('button', { name: /test$/i })
      expect(testButton).toBeDisabled()
    })
  })

  describe('Webhooks Section', () => {
    it('displays webhook URL', async () => {
      await renderExpanded({ apiEndpoint: 'https://api.example.com/' })

      expect(screen.getByText('https://api.example.com/webhooks/test_source')).toBeInTheDocument()
    })

    it('copies webhook URL to clipboard', async () => {
      const user = await renderExpanded({ apiEndpoint: 'https://api.example.com/' })

      await user.click(screen.getByRole('button', { name: 'Copy webhook URL' }))

      // user-event's clipboard stub records what the card wrote.
      expect(await navigator.clipboard.readText()).toBe('https://api.example.com/webhooks/test_source')
    })

    it('shows documentation link when provided', async () => {
      await renderExpanded()

      const docsLink = screen.getByRole('link', { name: /docs/i })
      expect(docsLink).toHaveAttribute('href', 'https://docs.example.com')
    })
  })

  describe('S3 Import Source', () => {
    it('renders S3ImportExplorer for s3_import source', async () => {
      const user = userEvent.setup()
      const s3Manifest: PluginManifest = {
        id: 's3_import',
        name: 'S3 Import',
        icon: 'Package',
        enabled: true,
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: true,
      }

      renderCard({ manifest: s3Manifest })

      await user.click(screen.getByRole('button', { name: /s3 import/i }))

      expect(screen.getByTestId('s3-import-explorer')).toBeInTheDocument()
    })
  })

  describe('Setup Instructions Colors', () => {
    it('applies blue color theme', async () => {
      await renderExpanded()

      const instructionsSection = screen.getByText('Setup Instructions').closest('div')
      expect(instructionsSection).toHaveClass('bg-info-subtle')
    })

    it('applies orange color theme', async () => {
      const user = userEvent.setup()
      const orangeManifest: PluginManifest = {
        ...mockManifest,
        setup: { ...MOCK_SETUP, color: 'orange' },
      }

      renderCard({ manifest: orangeManifest })

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const instructionsSection = screen.getByText('Setup Instructions').closest('div')
      expect(instructionsSection).toHaveClass('bg-warn-subtle')
    })
  })

  describe('Multiline Fields', () => {
    it('renders textarea for multiline fields', async () => {
      const user = userEvent.setup()
      const multilineManifest: PluginManifest = {
        id: 'test_source',
        name: 'Test',
        icon: 'Synthetic',
        enabled: true,
        config: [{ key: 'config', label: 'Config', type: 'textarea', placeholder: 'Enter config', required: false, secret: false }],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
      }

      renderCard({ manifest: multilineManifest })

      await user.click(screen.getByRole('button', { name: /test/i }))

      const textarea = screen.getByPlaceholderText('Enter config')
      expect(textarea.tagName.toLowerCase()).toBe('textarea')
    })
  })
})

describe('SourceCard — one /sources/status call per page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIntegrationStatus.mockResolvedValue({})
  })

  it('shares one status read across every card, each card showing its own entry', async () => {
    // Production made 5 identical calls on the plugins tab, one per card,
    // queuing from 1.5 s to 4.0 s (QA perf track).
    mockGetSourcesStatus.mockResolvedValue({ sources: { test_source: { enabled: true }, other_source: { enabled: false } } })
    const other: PluginManifest = { ...mockManifest, id: 'other_source', name: 'Other Source' }

    renderWithQueryClient(
      <>
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" isAdmin />
        <SourceCard manifest={other} apiEndpoint="https://api.example.com" isAdmin />
      </>,
    )

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked()
    })
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked()
    expect(mockGetSourcesStatus).toHaveBeenCalledExactlyOnceWith()
  })
})
