/**
 * @fileoverview The preview drawer of one library item: its details and the 5-minute download link, the text page by
 * page (Markdown through the light reader, any other format as written), Retry (a failed item's, a stale extraction's,
 * which is no longer polled), the metadata editor (only what
 * changed, with `expected_version`; 409 `stale` said and reloaded; a taken short name beside its field), and what a
 * viewer, a pending item and a missing one show.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { FAQ_ID, Q3_ID, detailOf, faqItem, libraryItem } from './library-fixtures'
import type { ProjectOption } from './libraryFilters'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { default: PreviewDrawer } = await import('./PreviewDrawer')

const ITEM = `/projects/library/${Q3_ID}`
const textOf = (page: number, text = `The text of page ${String(page)}`, paged = true) => ({ item_id: Q3_ID, page, parts: 3, paged, text })
const PROJECTS: readonly ProjectOption[] = [{ id: 'p_1', name: 'Onboarding revamp' }]

const route = (routes: Record<string, RouteHandler>) => routeFetchApi(routes, { ignoreQuery: true })

interface DrawerProps { itemId?: string; page?: number; canWrite?: boolean; projects?: readonly ProjectOption[] | null }

function renderDrawer({ itemId = Q3_ID, page = 1, canWrite = true, projects = PROJECTS }: DrawerProps = {}) {
  const onPage = vi.fn<(page: number) => void>()
  const onClose = vi.fn<() => void>()
  const user = userEvent.setup()
  renderWithQueryClient(<PreviewDrawer itemId={itemId} page={page} onPage={onPage} onClose={onClose} canWrite={canWrite} projects={projects} />)
  return { user, onPage, onClose }
}

const drawer = () => screen.findByRole('dialog', { name: /Q3 market report|Pricing FAQ/ })

beforeEach(() => {
  resetFetchApi()
})

describe('what the drawer shows', () => {
  it('lists the item\'s details and how the assistant reads it', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem({ project_id: 'p_1' })), [`GET ${ITEM}/text`]: () => textOf(1) })
    renderDrawer()
    const sheet = await drawer()
    expect(sheet).toHaveTextContent(/Source\s*Example Ltd research team\s*Document date\s*Oct 1, 2026/)
    expect(sheet).toHaveTextContent(/Project\s*Onboarding revamp.*File\s*q3-market-report\.pdf · PDF · 1\.8 MB\s*Pages\s*3/)
    expect(sheet).toHaveTextContent(/The file itself, when it is named in a chat.*Added\s*Alex Rivera, Nov 1, 2026/)
    expect(sheet).toHaveTextContent('Type #q3-market in the assistant to put this document into a chat.')
  })

  it('links to the original for 5 minutes, in a new tab', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem()), [`GET ${ITEM}/text`]: () => textOf(1) })
    renderDrawer()
    const link = within(await drawer()).getByRole('link', { name: /Download the original/ })
    expect(link).toHaveAttribute('href', 'https://s3.example.com/original?sig=1')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('pages through the text, kept within its pages', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem()), [`GET ${ITEM}/text`]: () => textOf(3) })
    const { user, onPage } = renderDrawer({ page: 9 })
    const sheet = await drawer()
    expect(await within(sheet).findByText('The text of page 3')).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith(`${ITEM}/text?page=3`, undefined)
    expect(within(sheet).getByRole('button', { name: 'Next' })).toBeDisabled()
    await user.click(within(sheet).getByRole('button', { name: 'Previous' }))
    expect(onPage).toHaveBeenCalledWith(2)
  })

  it('names a text without pages by its parts, and says a page without text', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem({ pages: undefined }), 2), [`GET ${ITEM}/text`]: () => ({ ...textOf(1, '  ', false), parts: 2 }) })
    renderDrawer()
    const sheet = await drawer()
    expect(await within(sheet).findByText('No text was found on this page.')).toBeInTheDocument()
    expect(within(sheet).getByText('Part 1 of 2')).toBeInTheDocument()
  })

  it('reads a Markdown item through the light reader, and any other format as written', async () => {
    route({
      [`GET /projects/library/${FAQ_ID}`]: () => detailOf(faqItem(), 1),
      [`GET /projects/library/${FAQ_ID}/text`]: () => ({ ...textOf(1, '# Pricing questions\n\nYes: **14 days**.', false), parts: 1 }),
    })
    renderDrawer({ itemId: FAQ_ID })
    const sheet = await drawer()
    expect(await within(sheet).findByRole('heading', { name: 'Pricing questions' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('navigation', { name: 'Pages of the text' })).not.toBeInTheDocument()
  })

  it('keeps the characters of a PDF\'s text as they are', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem({ truncated: true })), [`GET ${ITEM}/text`]: () => textOf(1, '# not a heading\n**plain**') })
    renderDrawer()
    const sheet = await drawer()
    expect(await within(sheet).findByText(/# not a heading/)).toHaveTextContent('**plain**')
    expect(within(sheet).getByText('This document is very long: only its first part was read.')).toBeInTheDocument()
  })

  it('says the text could not be loaded', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem()) })
    renderDrawer()
    expect(await within(await drawer()).findByRole('alert')).toHaveTextContent('The text could not be loaded.')
  })

  it('says a pending item waits for its file, with nothing to download or read', async () => {
    route({ [`GET ${ITEM}`]: () => ({ item: libraryItem({ status: 'pending', created_by: undefined }), preview: { text_parts: 0, original_url: null } }) })
    renderDrawer()
    const sheet = await drawer()
    expect(sheet).toHaveTextContent('Waiting for its file. If the upload did not finish, delete this item and upload the file again.')
    expect(within(sheet).queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('heading', { name: 'Text' })).not.toBeInTheDocument()
  })

  it('offers a viewer no edit, retry or delete', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem({ status: 'failed', error: 'Unreadable.' })) })
    renderDrawer({ canWrite: false, projects: null })
    const sheet = await drawer()
    expect(sheet).toHaveTextContent('Unreadable.')
    expect(within(sheet).queryByRole('button', { name: /Edit details|Read it again|Delete/ })).not.toBeInTheDocument()
  })

  it('says an item that is not there is not there', async () => {
    route({})
    renderDrawer()
    expect(await screen.findByRole('alert')).toHaveTextContent('This library item does not exist, or it was deleted.')
  })

  it('says a failed read, and reads again', async () => {
    route({ [`GET ${ITEM}`]: () => { throw new ApiError(500) } })
    const { user } = renderDrawer()
    expect(await screen.findByRole('alert')).toHaveTextContent('This item could not be loaded.')
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem()), [`GET ${ITEM}/text`]: () => textOf(1) })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await drawer()).toBeInTheDocument()
  })
})

describe('retry', () => {
  it('reads a failed item again', async () => {
    const server = { status: 'failed' }
    route({
      [`GET ${ITEM}`]: () => detailOf(libraryItem({ status: server.status, error: 'The reading stopped.' })),
      [`POST ${ITEM}/retry`]: () => {
        server.status = 'extracting'
        return { item: libraryItem({ status: 'extracting' }) }
      },
    })
    const { user } = renderDrawer()
    await user.click(within(await drawer()).getByRole('button', { name: 'Read it again' }))
    expect(await screen.findByText('Its text is being read. This page updates when it is ready.')).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith(`${ITEM}/retry`, { method: 'POST' })
  })

  it('offers a stale extraction a retry, and no longer reads the item again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    onTestFinished(() => { vi.useRealTimers() })
    route({
      [`GET ${ITEM}`]: () => detailOf(libraryItem({ status: 'extracting', stale: true })),
      [`POST ${ITEM}/retry`]: () => ({ item: libraryItem({ status: 'extracting' }) }),
    })
    const { user } = renderDrawer()
    const sheet = await drawer()
    expect(sheet).toHaveTextContent('Its text has not been read after 16 minutes: the reading stopped. Read it again.')
    const reads = () => vi.mocked(fetchApi).mock.calls.filter(([path]) => path === ITEM).length
    const before = reads()
    await act(async () => { await vi.advanceTimersByTimeAsync(8200) })
    expect(reads()).toBe(before)
    await user.click(within(sheet).getByRole('button', { name: 'Read it again' }))
    expect(fetchApi).toHaveBeenCalledWith(`${ITEM}/retry`, { method: 'POST' })
  })

  it('offers no retry while an extraction is still in time', async () => {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem({ status: 'extracting' })) })
    renderDrawer()
    const sheet = await drawer()
    expect(sheet).toHaveTextContent('Its text is being read.')
    expect(within(sheet).queryByRole('button', { name: 'Read it again' })).not.toBeInTheDocument()
  })

  it('says why a retry was refused', async () => {
    route({
      [`GET ${ITEM}`]: () => detailOf(libraryItem({ status: 'failed' })),
      [`POST ${ITEM}/retry`]: () => { throw new ApiError(409, 'Only a failed item', 'not_failed') },
    })
    const { user } = renderDrawer()
    const sheet = await drawer()
    expect(sheet).toHaveTextContent('Its text could not be read.')
    await user.click(within(sheet).getByRole('button', { name: 'Read it again' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Only a failed item can be read again.')
  })
})

describe('the editor', () => {
  async function openEditor(routes: Record<string, RouteHandler>) {
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem()), [`GET ${ITEM}/text`]: () => textOf(1), ...routes })
    const rendered = renderDrawer()
    await rendered.user.click(within(await drawer()).getByRole('button', { name: 'Edit details' }))
    return { ...rendered, form: screen.getByRole('form', { name: 'Edit the item\'s details' }) }
  }

  it('saves only what changed, with the version it was opened at', async () => {
    const { user, form } = await openEditor({ [`PUT ${ITEM}`]: () => ({ item: libraryItem({ title: 'Q3 report', tags: ['market'], project_id: 'p_1', version: 3 }) }) })
    await user.clear(within(form).getByRole('textbox', { name: 'Title' }))
    await user.type(within(form).getByRole('textbox', { name: 'Title' }), 'Q3 report')
    await user.clear(within(form).getByRole('textbox', { name: 'Tags' }))
    await user.type(within(form).getByRole('textbox', { name: 'Tags' }), 'Market')
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'Onboarding revamp')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(sentFetchApiBody(ITEM, 'PUT')).toStrictEqual({ expected_version: 2, title: 'Q3 report', tags: ['market'], project_id: 'p_1' })
  })

  it('sends every field it changes', async () => {
    const { user, form } = await openEditor({ [`PUT ${ITEM}`]: () => ({ item: libraryItem({ version: 3 }) }) })
    await user.clear(within(form).getByRole('textbox', { name: 'Short name' }))
    await user.type(within(form).getByRole('textbox', { name: 'Short name' }), 'Q3-Report')
    await user.clear(within(form).getByRole('textbox', { name: 'Source' }))
    await user.clear(within(form).getByLabelText('Document date'))
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(sentFetchApiBody(ITEM, 'PUT')).toStrictEqual({ expected_version: 2, slug: 'q3-report', source: '', doc_date: '' })
  })

  it('closes without a request when nothing changed', async () => {
    const { user, form } = await openEditor({})
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([, options]) => options?.method === 'PUT')).toStrictEqual([])
  })

  it('waits for a valid short name', async () => {
    const { user, form } = await openEditor({})
    await user.type(within(form).getByRole('textbox', { name: 'Short name' }), '-')
    expect(within(form).getByRole('textbox', { name: 'Short name' })).toHaveAttribute('aria-invalid', 'true')
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('says a short name is taken beside the field', async () => {
    const { user, form } = await openEditor({ [`PUT ${ITEM}`]: () => { throw new ApiError(409, 'taken', 'slug_taken') } })
    await user.clear(within(form).getByRole('textbox', { name: 'Short name' }))
    await user.type(within(form).getByRole('textbox', { name: 'Short name' }), 'pricing-faq')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await within(form).findByRole('textbox', { name: 'Short name', description: /already has this short name/ })).toBeInTheDocument()
  })

  it('says the item changed meanwhile, and starts again from what it reloads', async () => {
    const { user, form } = await openEditor({ [`PUT ${ITEM}`]: () => { throw new ApiError(409, 'stale', 'stale') } })
    await user.clear(within(form).getByRole('textbox', { name: 'Title' }))
    await user.type(within(form).getByRole('textbox', { name: 'Title' }), 'Mine')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('This item was changed since you opened it. Reload it and try again.')
    route({ [`GET ${ITEM}`]: () => detailOf(libraryItem({ title: 'Theirs', version: 3 })), [`GET ${ITEM}/text`]: () => textOf(1) })
    await user.click(within(form).getByRole('button', { name: 'Reload' }))
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Theirs')
  })

  it('says any other refusal', async () => {
    const { user, form } = await openEditor({ [`PUT ${ITEM}`]: () => { throw new ApiError(403, 'no') } })
    await user.type(within(form).getByRole('textbox', { name: 'Source' }), ', 2026')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Adding or changing library items needs the editor or admin role')
  })
})
