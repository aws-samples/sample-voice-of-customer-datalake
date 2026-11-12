/**
 * A list read a page at a time (`useCursorPages` + `CursorPagesList`): loading, a failed first read with Try again
 * (or the caller's own failure), nothing to list, the rows, and "Show more" while there is another page.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { useCursorPages } from '../../hooks/useCursorPages'
import CursorPagesList from './CursorPagesList'

const COPY = { loading: 'Loading…', loadFailed: 'Could not load.', more: 'Show more', moreFailed: 'Next page failed.', refreshFailed: 'Could not refresh.', empty: 'Nothing yet.' }

type FetchPage = (cursor: string | null) => Promise<{ rows: string[]; nextCursor: string | null }>

function Harness({ fetchPage, failure }: Readonly<{ fetchPage: FetchPage; failure?: ReactNode }>) {
  const { query, rows } = useCursorPages<string>(['cursor-pages-test'], fetchPage)
  return (
    <CursorPagesList query={query} count={rows.length} copy={COPY} failure={failure}>
      <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>
    </CursorPagesList>
  )
}

describe('CursorPagesList', () => {
  it('says it is loading, then shows the rows of the first page', async () => {
    renderWithQueryClient(<Harness fetchPage={() => Promise.resolve({ rows: ['a'], nextCursor: null })} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByText('a')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
  })

  it('reads the next page by its cursor on Show more', async () => {
    const fetchPage = vi.fn<FetchPage>((cursor) => Promise.resolve(cursor === null ? { rows: ['a'], nextCursor: 'n' } : { rows: ['b'], nextCursor: null }))
    renderWithQueryClient(<Harness fetchPage={fetchPage} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('b')).toBeInTheDocument()
    expect(fetchPage).toHaveBeenLastCalledWith('n')
  })

  it('says so beside Show more when the next page fails, or shows the caller\'s own failure there', async () => {
    const nextFails: FetchPage = (cursor) => (cursor === null ? Promise.resolve({ rows: ['a'], nextCursor: 'n' }) : Promise.reject(new Error('API Error: 500')))
    const first = renderWithQueryClient(<Harness fetchPage={nextFails} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Next page failed.')
    first.unmount()
    renderWithQueryClient(<Harness fetchPage={nextFails} failure={<p role="alert">Refused.</p>} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Refused.')
  })

  it('says so above the rows when reading them again fails, and Try again reads them once more', async () => {
    const answers = [true, false, true]
    const fetchPage = vi.fn<FetchPage>(() => (answers.shift() === false ? Promise.reject(new Error('API Error: 500')) : Promise.resolve({ rows: ['a'], nextCursor: null })))
    const client = createTestQueryClient()
    renderWithQueryClient(<Harness fetchPage={fetchPage} />, client)
    expect(await screen.findByText('a')).toBeInTheDocument()
    await act(() => client.refetchQueries({ queryKey: ['cursor-pages-test'] }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('says there is nothing to list', async () => {
    renderWithQueryClient(<Harness fetchPage={() => Promise.resolve({ rows: [], nextCursor: null })} />)
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument()
  })

  it('offers Try again for a failed first read, or shows the caller\'s own failure', async () => {
    const failing: FetchPage = () => Promise.reject(new Error('API Error: 500'))
    const first = renderWithQueryClient(<Harness fetchPage={failing} />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
    first.unmount()
    renderWithQueryClient(<Harness fetchPage={failing} failure={<p>Refused.</p>} />)
    expect(await screen.findByText('Refused.')).toBeInTheDocument()
  })
})
