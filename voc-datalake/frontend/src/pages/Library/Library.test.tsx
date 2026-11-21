/**
 * @fileoverview The Library page (7.62.00): the list with its filters as the list's query, paging, the empty and
 * failed states, a viewer's read-only page, the refetch while an item is read, and the preview drawer opened by a
 * row and by `?item=&page=` (the assistant's citation chips), with its delete confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { at } from '@test/defined'
import LocationSearch from '@test/LocationSearch'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import { Q3_ID, SURVEY_ID, detailOf, libraryItem, libraryPage, surveyItem } from './library-fixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { default: Library } = await import('./Library')

const PROJECTS = { projects: [{ project_id: 'p_1', name: 'Onboarding revamp' }] }

const route = (routes: Record<string, RouteHandler>) => routeFetchApi({ 'GET /projects': () => PROJECTS, ...routes }, { ignoreQuery: true })
const listCalls = () => fetchApi.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/projects/library') && !path.startsWith('/projects/library/'))

function renderPage(entry = '/library') {
  return render(<><Library /><LocationSearch /></>, { initialEntries: [entry] })
}

beforeEach(() => {
  resetFetchApi()
})

afterEach(() => {
  setCurrentWorkspace(null)
})

describe('the list', () => {
  it('shows each item with its short name, format, size, dates, tags and who added it', async () => {
    route({ 'GET /projects/library': () => libraryPage([libraryItem(), surveyItem()]) })
    renderPage()
    const row = await screen.findByRole('button', { name: /Q3 market report \(Example Ltd\)/ })
    expect(row).toHaveTextContent('#q3-market')
    expect(row).toHaveTextContent(/pdf.*1\.8 MB.*Dated Oct 1, 2026.*Added Nov 1, 2026 by Alex Rivera.*market.*q3/)
    const unnamed = screen.getByRole('button', { name: /Onboarding survey results/ })
    expect(unnamed).toHaveTextContent('Added Nov 5, 2026')
    expect(unnamed).not.toHaveTextContent(/ by /)
  })

  it('says a failed item failed and why', async () => {
    route({ 'GET /projects/library': () => libraryPage([libraryItem({ status: 'failed', error: 'This PDF is protected by a password.' })]) })
    renderPage()
    const row = await screen.findByRole('button', { name: /Q3 market report/ })
    expect(row).toHaveTextContent(/Failed/)
    expect(row).toHaveTextContent('This PDF is protected by a password.')
  })

  it('sends the search, tag, project and sort as the list\'s query', async () => {
    route({ 'GET /projects/library': () => libraryPage([libraryItem()]) })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /Q3 market report/ })
    await user.type(screen.getByRole('searchbox', { name: 'Search the library' }), 'market')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tag' }), 'q3')
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Project' }), 'Onboarding revamp')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'Document date')
    await waitFor(() => expect(listCalls().at(-1)).toBe('/projects/library?q=market&tag=q3&project_id=p_1&sort=doc_date'))
    expect(listCalls()[0]).toBe('/projects/library?sort=newest')
  })

  it('reads the next page from next_cursor', async () => {
    route({
      'GET /projects/library': () => (listCalls().length > 1
        ? libraryPage([surveyItem()])
        : libraryPage([libraryItem()], { next_cursor: '50', total: 2 })),
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: /Onboarding survey results/ })).toBeInTheDocument()
    expect(listCalls().at(-1)).toBe('/projects/library?sort=newest&cursor=50')
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('says the library is empty and offers the upload', async () => {
    route({ 'GET /projects/library': () => libraryPage([]) })
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('No documents yet')).toBeInTheDocument()
    // The page's own button and the empty state's.
    await user.click(at(screen.getAllByRole('button', { name: 'Upload files' }), 1))
    expect(screen.getByRole('dialog', { name: 'Upload to the library' })).toBeInTheDocument()
  })

  it('says nothing matches the filters, rather than that the library is empty', async () => {
    route({ 'GET /projects/library': () => libraryPage([]) })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('No documents yet')
    await user.type(screen.getByRole('searchbox'), 'zzz')
    expect(await screen.findByText('No library items match these filters.')).toBeInTheDocument()
  })

  it('says the list could not be loaded, and loads it again', async () => {
    route({})
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('The library could not be loaded.')
    route({ 'GET /projects/library': () => libraryPage([libraryItem()]) })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Q3 market report/ })).toBeInTheDocument()
  })

  it('tells the person what the library is and where feedback is imported', async () => {
    route({ 'GET /projects/library': () => libraryPage([]) })
    renderPage()
    const about = await screen.findByRole('region', { name: 'About the library' })
    expect(about).toHaveTextContent(/not feedback: they never reach metrics, sentiment or categories/)
    expect(about).toHaveTextContent(/type # and an item's short name/)
    expect(within(about).getByRole('link', { name: 'Data sources' })).toHaveAttribute('href', '/scrapers')
  })

  it('reads the list again while an item is still being read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    onTestFinished(() => { vi.useRealTimers() })
    route({ 'GET /projects/library': () => libraryPage([libraryItem({ status: 'extracting' })]) })
    renderPage()
    await screen.findByRole('button', { name: /Q3 market report/ })
    const before = listCalls().length
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(listCalls().length).toBeGreaterThan(before)
  })

  it.each([
    ['an extraction', 'extracting'],
    ['an upload whose link expired', 'pending'],
  ] as const)('stops reading the list again once the server says %s is stale', async (_what, status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    onTestFinished(() => { vi.useRealTimers() })
    route({ 'GET /projects/library': () => libraryPage([libraryItem({ status, stale: true })]) })
    renderPage()
    await screen.findByRole('button', { name: /Q3 market report/ })
    const before = listCalls().length
    await act(async () => { await vi.advanceTimersByTimeAsync(8200) })
    expect(listCalls()).toHaveLength(before)
  })
})

describe('in a workspace', () => {
  it('offers a viewer no upload and no project filter, and says why', async () => {
    setCurrentWorkspace({ id: 'ws_1', slug: 'example-ltd', name: 'Example Ltd', role: 'viewer' })
    route({ 'GET /projects/library': () => libraryPage([libraryItem()]) })
    renderPage()
    await screen.findByRole('button', { name: /Q3 market report/ })
    expect(screen.queryByRole('button', { name: 'Upload files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('needs the editor or admin role')
  })
})

describe('the preview drawer', () => {
  const textOf = (page: number) => ({ item_id: Q3_ID, page, parts: 3, paged: true, text: `The text of page ${String(page)}` })

  it('opens at the item and page the address names (a citation chip)', async () => {
    route({
      'GET /projects/library': () => libraryPage([libraryItem()]),
      [`GET /projects/library/${Q3_ID}`]: () => detailOf(libraryItem()),
      [`GET /projects/library/${Q3_ID}/text`]: () => textOf(2),
    })
    renderPage(`/library?item=${Q3_ID}&page=2`)
    const drawer = await screen.findByRole('dialog', { name: 'Q3 market report (Example Ltd)' })
    expect(await within(drawer).findByText('The text of page 2')).toBeInTheDocument()
    expect(within(drawer).getByText('Page 2 of 3')).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith(`/projects/library/${Q3_ID}/text?page=2`, undefined)
  })

  it('opens from a row, and closing it leaves the address', async () => {
    route({
      'GET /projects/library': () => libraryPage([libraryItem(), surveyItem()]),
      [`GET /projects/library/${SURVEY_ID}`]: () => detailOf(surveyItem({ status: 'extracting' }), 0),
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /Onboarding survey results/ }))
    expect(screen.getByTestId('search')).toHaveTextContent(`?item=${SURVEY_ID}`)
    expect(await screen.findByText('Its text is being read. This page updates when it is ready.')).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByTestId('search')).toBeEmptyDOMElement()
  })

  it('deletes the item behind a confirmation', async () => {
    route({
      'GET /projects/library': () => libraryPage([libraryItem()]),
      [`GET /projects/library/${Q3_ID}`]: () => detailOf(libraryItem()),
      [`GET /projects/library/${Q3_ID}/text`]: () => textOf(1),
      [`DELETE /projects/library/${Q3_ID}`]: () => ({ success: true, deleted: Q3_ID }),
    })
    const user = userEvent.setup()
    renderPage(`/library?item=${Q3_ID}`)
    const drawer = await screen.findByRole('dialog', { name: 'Q3 market report (Example Ltd)' })
    await user.click(within(drawer).getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('dialog', { name: 'Delete this library item?' })
    expect(confirm).toHaveTextContent('"Q3 market report (Example Ltd)" is deleted for good')
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement())
    expect(fetchApi).toHaveBeenCalledWith(`/projects/library/${Q3_ID}`, { method: 'DELETE' })
  })

  it('says why a delete was refused (an admin or the uploader deletes)', async () => {
    route({
      'GET /projects/library': () => libraryPage([libraryItem()]),
      [`GET /projects/library/${Q3_ID}`]: () => detailOf(libraryItem()),
      [`GET /projects/library/${Q3_ID}/text`]: () => textOf(1),
      [`DELETE /projects/library/${Q3_ID}`]: () => { throw new ApiError(403, 'Only an admin or the person who uploaded it can delete this item') },
    })
    const user = userEvent.setup()
    renderPage(`/library?item=${Q3_ID}`)
    await user.click(within(await screen.findByRole('dialog', { name: /Q3 market report/ })).getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('dialog', { name: 'Delete this library item?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('Only an admin or the person who uploaded it can delete this item.')
    expect(screen.getByTestId('search')).toHaveTextContent(`?item=${Q3_ID}`)
  })
})
