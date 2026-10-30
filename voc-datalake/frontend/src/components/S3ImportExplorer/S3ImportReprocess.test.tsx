/**
 * @fileoverview Reprocessing one imported file from the S3 import explorer (issue #144):
 * the confirmation explains duplicates and category reprocess, the run is started for
 * the row's key, and its status is polled until it settles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import type { S3ImportFile } from '../../api/types'
import type { S3ImportRun } from '../../api/s3ImportReprocessApi'

// The explorer's own calls; beforeEach answers the sources and files reads.
vi.mock('../../api/client', () => ({
  api: Object.fromEntries(
    ['getS3ImportSources', 'getS3ImportFiles', 'createS3ImportSource', 'deleteS3ImportFile', 'getS3UploadUrl']
      .map((name) => [name, vi.fn()]),
  ),
}))

vi.mock('../../api/s3ImportReprocessApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/s3ImportReprocessApi')>(),
  reprocessS3ImportFile: vi.fn(),
  getS3ImportReprocessRun: vi.fn(),
}))

import { api } from '../../api/client'
import { getS3ImportReprocessRun, reprocessS3ImportFile } from '../../api/s3ImportReprocessApi'
import S3ImportExplorer from './S3ImportExplorer'
import { describeImportKey } from './importKey'

const mockStart = vi.mocked(reprocessS3ImportFile)
const mockPoll = vi.mocked(getS3ImportReprocessRun)

const FILE: S3ImportFile = {
  key: 'reviews/june.csv', filename: 'june.csv', source: 'reviews', size: 2048,
  last_modified: '2025-01-15T10:30:00Z', status: 'pending',
}

function run(status: string, itemsFound = 0): S3ImportRun {
  return { run_id: 'run_s3_import_20260310120000_0a1b2c3d', key: FILE.key, status, items_found: itemsFound, errors: [] }
}

/** Mount with FILE listed, press its Reprocess button. */
async function openConfirm() {
  const user = userEvent.setup()
  renderWithQueryClient(<S3ImportExplorer />)
  await user.click(await screen.findByRole('button', { name: 'Reprocess file' }))
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
  // Implementations too: each test states what the start and the poll answer.
  mockStart.mockReset()
  mockPoll.mockReset()
  vi.mocked(api.getS3ImportSources).mockResolvedValue({ bucket: 'test-bucket', sources: [] })
  vi.mocked(api.getS3ImportFiles).mockResolvedValue({ files: [FILE], bucket: 'test-bucket' })
})

describe('reprocessing a file', () => {
  it('asks first, naming the source and explaining duplicates and category reprocess', async () => {
    await openConfirm()

    expect(screen.getByRole('heading', { name: 'Reprocess june.csv?' })).toBeInTheDocument()
    const message = screen.getByText(/skipped as duplicates/)
    expect(message).toHaveTextContent('S3 - reviews')
    expect(message).toHaveTextContent('Reprocess existing feedback')
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('cancelling starts nothing', async () => {
    const user = await openConfirm()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('heading', { name: 'Reprocess june.csv?' })).not.toBeInTheDocument()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('shows the run as running while the poll says so', async () => {
    mockStart.mockResolvedValue(run('running'))
    mockPoll.mockResolvedValue(run('running'))
    const user = await openConfirm()

    await user.click(screen.getByRole('button', { name: 'Reprocess' }))

    expect(await screen.findByText('Reprocessing june.csv...')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('starts a run for the row key and polls it until it completes', async () => {
    mockStart.mockResolvedValue(run('running'))
    mockPoll.mockResolvedValueOnce(run('running')).mockResolvedValue(run('completed', 5))
    const user = await openConfirm()

    await user.click(screen.getByRole('button', { name: 'Reprocess' }))

    expect(mockStart).toHaveBeenCalledWith('reviews/june.csv')
    expect(await screen.findByText(/Reprocessed june.csv: 5 rows sent to the pipeline/, {}, { timeout: 4000 }))
      .toBeInTheDocument()
    expect(mockPoll).toHaveBeenCalledWith('run_s3_import_20260310120000_0a1b2c3d')
  })

  it('shows a run that failed, and can dismiss it', async () => {
    mockStart.mockResolvedValue(run('error'))
    mockPoll.mockResolvedValue(run('error'))
    const user = await openConfirm()

    await user.click(screen.getByRole('button', { name: 'Reprocess' }))

    expect(await screen.findByText(/Reprocessing june.csv failed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Reprocessing june.csv failed/)).not.toBeInTheDocument()
  })

  it('keeps the dialog open with the reason when the run cannot start', async () => {
    mockStart.mockRejectedValue(new Error('File not found: reviews/june.csv'))
    const user = await openConfirm()

    await user.click(screen.getByRole('button', { name: 'Reprocess' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start reprocessing: File not found: reviews/june.csv')
    expect(screen.getByRole('heading', { name: 'Reprocess june.csv?' })).toBeInTheDocument()
  })

  it('stops polling and shows failure when a poll is refused', async () => {
    mockStart.mockResolvedValue(run('running'))
    mockPoll.mockRejectedValue(new Error('Run not found'))
    const user = await openConfirm()

    await user.click(screen.getByRole('button', { name: 'Reprocess' }))

    expect(await screen.findByText(/Reprocessing june.csv failed/, {}, { timeout: 4000 })).toBeInTheDocument()
    expect(mockPoll).toHaveBeenCalledWith('run_s3_import_20260310120000_0a1b2c3d')
  })
})

describe('describeImportKey', () => {
  it.each([
    ['reviews/june.csv', 'june.csv', 'S3 - reviews'],
    ['processed/reviews/may.csv', 'may.csv', 'S3 - reviews'],
    // A key with no folder is labelled as the ingestor labels it (`_get_source_from_key`).
    ['loose.csv', 'loose.csv', 'S3 - Import'],
    ['processed/loose.csv', 'loose.csv', 'S3 - processed'],
  ])('%s is %s under %s', (key, filename, source) => {
    expect(describeImportKey(key)).toStrictEqual({ filename, source })
  })
})
