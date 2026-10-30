/**
 * @fileoverview Imports history never shows a raw import id: while a row loads
 * it reads "Loading import…", and an import the API no longer knows reads
 * "This import is no longer available." (wave 3: ids → plain words).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: MemoryImports } = await import('./MemoryImports')

const IMPORT_ID = 'imp_0123456789abcdef'

beforeEach(() => {
  resetFetchApi()
  vi.mocked(localStorage.getItem).mockImplementation((key) => (key === 'voc-memory-imports' ? JSON.stringify([IMPORT_ID]) : null))
})

describe('Imports history', () => {
  it('says the import is unavailable instead of printing its id', async () => {
    routeFetchApi({}, { missStatus: 404, ignoreQuery: true })
    renderWithQueryClient(<MemoryImports />)
    expect(await screen.findByText('This import is no longer available.')).toBeInTheDocument()
    expect(screen.queryByText(IMPORT_ID)).not.toBeInTheDocument()
  })

  it('shows a loading line, not the id, before the status arrives', () => {
    routeFetchApi({ [`GET /memory/imports/${IMPORT_ID}`]: () => new Promise(() => {}) }, { ignoreQuery: true })
    renderWithQueryClient(<MemoryImports />)
    expect(screen.getByText('Loading import…')).toBeInTheDocument()
    expect(screen.queryByText(IMPORT_ID)).not.toBeInTheDocument()
  })
})
