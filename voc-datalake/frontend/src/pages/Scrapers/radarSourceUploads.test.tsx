/**
 * "Radar source" on the CSV and JSON uploads (docs/radar.md): the brand comes from the Radar
 * brand list (not a source profile), is sent as `radar_brand`, and the success note names it;
 * an ordinary upload sends no `radar_brand`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { RADAR_BRANDS } from '@test/radarBrandFixtures'
import { dimensionsWire, sourcesWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import CsvUploadModal from './CsvUploadModal'
import JsonUploadModal from './JsonUploadModal'

const mockUploadCsv = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()
const mockUploadJson = vi.fn<(items: unknown[], sourceId?: string, radarBrand?: string) => Promise<unknown>>()

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    uploadCsvFeedback: (params: Record<string, unknown>) => mockUploadCsv(params),
    uploadJsonFeedback: (items: unknown[], sourceId?: string, radarBrand?: string) => mockUploadJson(items, sourceId, radarBrand),
  },
}))


const CSV = 'id,text\n1,"Great app"\n'
const JSON_ITEMS = [{ id: 'a', text: 'Great', source: 'zendesk', timestamp: '2026-03-20T14:30:00Z' }]

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}

function csvFile(): File {
  const file = new File([CSV], 'feedback.csv', { type: 'text/csv' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(CSV) })
  return file
}

const jsonFile = (): File => new File([JSON.stringify(JSON_ITEMS)], 'feedback.json', { type: 'application/json' })

async function chooseBrand(user: ReturnType<typeof userEvent.setup>, key: string) {
  await user.click(screen.getByRole('checkbox', { name: 'Radar source: reviews of another brand' }))
  await user.selectOptions(await screen.findByLabelText('Radar brand'), key)
}

beforeEach(() => {
  resetFetchApi()
  mockUploadCsv.mockReset()
  mockUploadJson.mockReset()
  mockUploadCsv.mockResolvedValue({ success: true, imported_count: 1, total_rows: 1 })
  mockUploadJson.mockResolvedValue({ success: true, imported_count: 1, total_items: 1 })
  routeFetchApi({
    'GET /radar/brands': () => ({ brands: RADAR_BRANDS }),
    'GET /settings/dimensions': () => dimensionsWire,
    'GET /settings/sources': () => sourcesWire,
  })
})

describe('CsvUploadModal Radar source', () => {
  it('sends the chosen brand and names it when done', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<CsvUploadModal isOpen onClose={vi.fn()} />)
    await chooseBrand(user, 'globex')
    await user.upload(fileInput(), csvFile())
    await user.click(screen.getByRole('button', { name: /^upload$/i }))
    expect(await screen.findByText(/on the Radar page under Globex/)).toBeInTheDocument()
    expect(mockUploadCsv).toHaveBeenCalledWith(expect.objectContaining({ radar_brand: 'globex' }))
  })

  it('sends no radar_brand for our own feedback', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<CsvUploadModal isOpen onClose={vi.fn()} />)
    await user.upload(fileInput(), csvFile())
    await user.click(screen.getByRole('button', { name: /^upload$/i }))
    expect(await screen.findByText(/on the Feedback page/)).toBeInTheDocument()
    expect(mockUploadCsv.mock.lastCall?.[0]).not.toHaveProperty('radar_brand')
  })
})

describe('JsonUploadModal Radar source', () => {
  it('sends the chosen brand and names it when done', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<JsonUploadModal isOpen onClose={vi.fn()} />)
    await chooseBrand(user, 'acme')
    await user.upload(fileInput(), jsonFile())
    await user.click(await screen.findByRole('button', { name: /^import/i }))
    expect(await screen.findByText(/on the Radar page under Acme/)).toBeInTheDocument()
    expect(mockUploadJson).toHaveBeenCalledWith(JSON_ITEMS, undefined, 'acme')
  })

  it('sends no brand for our own feedback', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<JsonUploadModal isOpen onClose={vi.fn()} />)
    await user.upload(fileInput(), jsonFile())
    await user.click(await screen.findByRole('button', { name: /^import/i }))
    expect(mockUploadJson).toHaveBeenCalledWith(JSON_ITEMS, undefined, undefined)
  })
})
