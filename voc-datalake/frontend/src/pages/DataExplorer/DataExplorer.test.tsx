import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { configStoreModule } from '../Categories/categories-fixtures'
import enCommon from '../../../public/locales/en/common.json'

// Mock hooks. `isConfigured` is the hook's verdict on the API endpoint; a test flips it.
// `failed` names the view whose listing read failed with nothing cached.
const queriesState = vi.hoisted(() => {
  const state: { isConfigured: boolean; failed: 's3' | 'feedback' | null; retry: () => void } = {
    isConfigured: true, failed: null, retry: () => {},
  }
  return state
})
const failure = (view: 's3' | 'feedback') => ({
  loadFailed: queriesState.failed === view, retrying: false, retry: () => queriesState.retry(),
})
vi.mock('./useDataExplorerQueries', () => ({
  useDataExplorerQueries: () => ({
    isConfigured: queriesState.isConfigured,
    s3Data: { folders: [], files: [] },
    s3Loading: false,
    feedbackData: { items: [], total: 0, isLowerBound: false },
    feedbackLoading: false,
    s3Failure: failure('s3'),
    feedbackFailure: failure('feedback'),
    bucketsData: { buckets: [{ id: 'raw-data', label: 'Raw Data' }] },
    sourcesData: { sources: {} },
    refetch: vi.fn(),
  }),
}))

vi.mock('./useDataExplorerMutations', () => ({
  useDataExplorerMutations: () => ({
    saveS3Mutation: { mutate: vi.fn(), isPending: false, error: null },
    saveFeedbackMutation: { mutate: vi.fn(), isPending: false, error: null },
  }),
}))

vi.mock('./s3Handlers', () => ({
  openS3Editor: vi.fn(),
  openS3Creator: vi.fn(),
  downloadS3File: vi.fn(),
}))

vi.mock('../../store/configStore', () => configStoreModule())

// Mock subcomponents to simplify testing
vi.mock('./S3Browser', () => ({
  default: ({ path, onNavigateToFolder }: { path: string[]; onNavigateToFolder: (f: string) => void }) => (
    <div data-testid="s3-browser">
      <span>Path: {path.join('/')}</span>
      <button onClick={() => onNavigateToFolder('subfolder')}>Navigate to subfolder</button>
    </div>
  ),
}))

vi.mock('./ProcessedFeedbackView', () => ({
  default: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="processed-feedback-view">Search: {searchQuery}</div>
  ),
}))

vi.mock('./DataQualitySection', () => ({ default: () => <div data-testid="data-quality-section" /> }))

vi.mock('./EditModal', () => ({
  default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <div data-testid="edit-modal"><button onClick={onClose}>Close</button></div> : null,
}))

import DataExplorer from './DataExplorer'

/** Renders `ui` (the page by default) with a no-retry query client inside its router. */
function renderDataExplorer(ui: React.ReactElement = <DataExplorer />) {
  return renderWithQueryClient(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('DataExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queriesState.isConfigured = true
  })

  describe('rendering', () => {
    it('renders page header', () => {
      renderDataExplorer()

      expect(screen.getByText('Data Explorer')).toBeInTheDocument()
    })

    it('renders S3 browser by default', async () => {
      renderDataExplorer()

      await waitFor(() => {
        expect(screen.getByTestId('s3-browser')).toBeInTheDocument()
      })
    })

    it('renders New File button in S3 view', () => {
      renderDataExplorer()

      expect(screen.getByRole('button', { name: /new file/i })).toBeInTheDocument()
    })

    it('renders Refresh button', () => {
      renderDataExplorer()

      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })
})

describe('DataExplorer - a failed listing is not an empty folder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queriesState.isConfigured = true
    queriesState.failed = null
  })

  it('shows LoadFailed in place of the S3 browser, and its button retries', async () => {
    queriesState.failed = 's3'
    const retry = vi.fn()
    queriesState.retry = retry
    renderDataExplorer()

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(enCommon.loadFailed.message)
    expect(screen.queryByTestId('s3-browser')).not.toBeInTheDocument()
    await userEvent.setup().click(within(alert).getByRole('button', { name: enCommon.loadFailed.retry }))
    expect(retry).toHaveBeenCalledExactlyOnceWith()
  })

  it('a failed feedback read does not hide the S3 view it does not feed', () => {
    queriesState.failed = 'feedback'
    renderDataExplorer()

    expect(screen.getByTestId('s3-browser')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('DataExplorer - not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queriesState.isConfigured = false
  })

  it('shows configuration message when API not configured', () => {
    renderDataExplorer()

    expect(screen.getByText('Configure API endpoint in Administration → General to explore data')).toBeInTheDocument()
    expect(screen.queryByTestId('s3-browser')).not.toBeInTheDocument()
  })
})

describe('DataExplorer - the tab is in the URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queriesState.isConfigured = true
    queriesState.failed = null
  })

  function LocationProbe() {
    const location = useLocation()
    return <output data-testid="search">{location.search}</output>
  }

  it('puts the processed tab in ?view=processed (the header shows the date picker only there) and back', async () => {
    const user = userEvent.setup()
    renderDataExplorer(<><DataExplorer /><LocationProbe /></>)

    await user.click(screen.getByRole('tab', { name: /processed feedback/i }))
    expect(screen.getByTestId('search')).toHaveTextContent('?view=processed')
    expect(screen.getByTestId('processed-feedback-view')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /s3 raw data/i }))
    expect(screen.getByTestId('search')).toBeEmptyDOMElement()
  })

  it('opens on the processed tab from a link', () => {
    renderWithQueryClient(<MemoryRouter initialEntries={['/data-explorer?view=processed']}><DataExplorer /></MemoryRouter>)

    expect(screen.getByTestId('processed-feedback-view')).toBeInTheDocument()
  })

  it('shows the data-quality section on the processed tab only (it follows the time range)', async () => {
    const user = userEvent.setup()
    renderDataExplorer()
    expect(screen.queryByTestId('data-quality-section')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /processed feedback/i }))
    expect(screen.getByTestId('data-quality-section')).toBeInTheDocument()
  })
})
