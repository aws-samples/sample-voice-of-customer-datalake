/**
 * @fileoverview The upload sheet: files the library takes not are refused before anything is sent; each accepted file
 * goes create → PUT (exactly the signed headers, with its progress) → uploaded; the server's refusals (a taken short
 * name, a full library) are said beside the file; a failed PUT takes its pending item back, so trying again makes one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { fakeXhrPerTest } from '@test/fakeXhr'
import { ApiError } from '../../lib/errors'
import { MAX_IMAGE_BYTES } from './libraryFormats'
import { Q3_ID, libraryItem } from './library-fixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { default: UploadSheet } = await import('./UploadSheet')

const xhr = fakeXhrPerTest()
const UPLOAD = { url: 'https://s3.example.com/put?sig=1', headers: { 'Content-Type': 'application/pdf', 'If-None-Match': '*' }, expires_in: 900 }
const created = () => ({ item: libraryItem({ status: 'pending' }), upload: UPLOAD })

const pdf = (name = 'Q3 Market Report.pdf') => new File(['%PDF-1.7 fictional'], name, { type: 'application/pdf' })

function sized(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const route = (routes: Record<string, RouteHandler>) => routeFetchApi(routes)

function renderSheet(onClose = vi.fn()) {
  const user = userEvent.setup({ applyAccept: false })
  renderWithQueryClient(<UploadSheet isOpen onClose={onClose} />)
  const choose = (...files: File[]) => user.upload(screen.getByTestId('library-file-input'), files)
  return { user, choose, onClose }
}

/** The sheet open over `routes`, the PDF chosen and Upload pressed, until its PUT has started. */
async function uploadStarted(routes: Record<string, RouteHandler>) {
  route(routes)
  const sheet = renderSheet()
  await sheet.choose(pdf())
  await sheet.user.click(screen.getByRole('button', { name: 'Upload (1)' }))
  await waitFor(() => expect(xhr.sent).toHaveLength(1))
  return sheet
}

beforeEach(() => {
  resetFetchApi()
})

describe('choosing files', () => {
  it('refuses a type the library takes not, an empty file and an image too large, before anything is sent', async () => {
    const { choose } = renderSheet()
    await choose(new File(['x'], 'song.mp3', { type: 'audio/mpeg' }), new File([], 'empty.txt', { type: 'text/plain' }),
      sized(new File(['x'], 'photo.png', { type: 'image/png' }), MAX_IMAGE_BYTES + 1))
    const alerts = within(screen.getByRole('list', { name: 'Files to upload' })).getAllByRole('alert').map((alert) => alert.textContent)
    expect(alerts).toStrictEqual([
      expect.stringMatching(/^This file type is not supported\. Upload one of: \.pdf, \.csv/),
      'This file is empty.',
      'This image is larger than 3.75 MB, the most an image can be.',
    ])
    expect(screen.getByRole('button', { name: 'Upload (0)' })).toBeDisabled()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('refuses a document over 25 MB', async () => {
    const { choose } = renderSheet()
    await choose(sized(pdf('huge.pdf'), 25 * 1024 * 1024 + 1))
    expect(screen.getByRole('alert')).toHaveTextContent('This file is larger than 25 MB, the most a library item can be.')
  })

  it('starts each file from its name: its title, and the short name the server would make', async () => {
    const { choose } = renderSheet()
    await choose(pdf())
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Q3 Market Report')
    expect(screen.getByRole('textbox', { name: 'Short name' })).toHaveAttribute('placeholder', 'q3-market-report')
    expect(screen.getByRole('button', { name: 'Upload (1)' })).toBeEnabled()
  })

  it('takes dropped files too, and a file can be removed', async () => {
    const { user } = renderSheet()
    const zone = screen.getByText('Drop files here, or choose them.').parentElement ?? document.body
    const files = [pdf('a.pdf'), pdf('b.pdf')]
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files } })
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files } })
    expect(screen.getByRole('button', { name: 'Upload (2)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
    expect(screen.getByRole('button', { name: 'Upload (1)' })).toBeInTheDocument()
  })

  it('says what is wrong with a file\'s details and waits until it is right', async () => {
    const { user, choose } = renderSheet()
    await choose(pdf())
    await user.clear(screen.getByRole('textbox', { name: 'Title' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Give the item a title.')
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Q3')
    await user.type(screen.getByRole('textbox', { name: 'Short name' }), '-q3')
    expect(screen.getByRole('alert')).toHaveTextContent(/A short name is 1 to 64 lower-case letters/)
    expect(screen.getByRole('button', { name: 'Upload (0)' })).toBeDisabled()
  })

  it('counts the tags given', async () => {
    const { user, choose } = renderSheet()
    await choose(pdf())
    await user.type(screen.getByRole('textbox', { name: 'Tags' }), Array.from({ length: 11 }, (_, index) => `t${String(index)}`).join(','))
    expect(screen.getByRole('alert')).toHaveTextContent('An item has at most 10 tags.')
    await user.clear(screen.getByRole('textbox', { name: 'Tags' }))
    await user.type(screen.getByRole('textbox', { name: 'Tags' }), 'x'.repeat(41))
    expect(screen.getByRole('alert')).toHaveTextContent('A tag is at most 40 characters.')
  })

  it('closes on Cancel', async () => {
    const { user, onClose } = renderSheet()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledWith()
  })
})

describe('uploading', () => {
  it('creates the item with its details, PUTs the file with the signed headers and its progress, then marks it uploaded', async () => {
    route({ 'POST /projects/library': created, [`POST /projects/library/${Q3_ID}/uploaded`]: () => ({ item: libraryItem({ status: 'extracting' }) }) })
    const { user, choose } = renderSheet()
    await choose(pdf())
    await user.type(screen.getByRole('textbox', { name: 'Short name' }), 'q3-market')
    await user.type(screen.getByRole('textbox', { name: 'Tags' }), 'Market, q3')
    await user.type(screen.getByRole('textbox', { name: 'Source' }), 'Example Ltd research team')
    fireEvent.change(screen.getByLabelText('Document date'), { target: { value: '2026-10-01' } })
    await user.click(screen.getByRole('button', { name: 'Upload (1)' }))
    await waitFor(() => expect(xhr.sent).toHaveLength(1))
    expect(sentFetchApiBody('/projects/library', 'POST')).toStrictEqual({
      filename: 'Q3 Market Report.pdf', content_type: 'application/pdf', bytes: 18, title: 'Q3 Market Report', slug: 'q3-market',
      source: 'Example Ltd research team', doc_date: '2026-10-01', tags: ['market', 'q3'],
    })
    expect([xhr.last().method, xhr.last().url, xhr.last().headers]).toStrictEqual(['PUT', UPLOAD.url, UPLOAD.headers])
  })

  it('shows the file\'s progress, then that it was uploaded', async () => {
    await uploadStarted({ 'POST /projects/library': created, [`POST /projects/library/${Q3_ID}/uploaded`]: () => ({ item: libraryItem({ status: 'extracting' }) }) })
    xhr.last().progress(5, 10)
    expect(await screen.findByRole('progressbar', { name: 'Upload of Q3 Market Report.pdf' })).toHaveAttribute('aria-valuenow', '50')
    xhr.last().respond(200)
    expect(await screen.findByText(/^Uploaded\. Its text is being read/)).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith(`/projects/library/${Q3_ID}/uploaded`, { method: 'POST' })
  })

  it('says a short name is taken, and sends again once another is chosen', async () => {
    route({ 'POST /projects/library': () => { throw new ApiError(409, 'Another library item already has this short name.', 'slug_taken') } })
    const { user, choose } = renderSheet()
    await choose(pdf())
    await user.type(screen.getByRole('textbox', { name: 'Short name' }), 'q3-market')
    await user.click(screen.getByRole('button', { name: 'Upload (1)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Another library item already has this short name. Choose another.')
    route({ 'POST /projects/library': created })
    await user.type(screen.getByRole('textbox', { name: 'Short name' }), '-2')
    await user.click(screen.getByRole('button', { name: 'Upload (1)' }))
    await waitFor(() => expect(xhr.sent).toHaveLength(1))
  })

  it.each([
    [new ApiError(409, 'full', 'library_full'), 'This library holds 1,000 items, its most. Delete some first.'],
    [new ApiError(400, 'no', 'unsupported_type'), 'This file type is not supported.'],
    [new ApiError(400, 'big', 'too_large'), 'This file is too large: files can be at most 25 MB, images at most 3.75 MB.'],
    [new ApiError(403, 'no'), 'Only an admin or the person who uploaded this item can change or delete it.'],
  ])('says the server\'s refusal %o', async (error, message) => {
    route({ 'POST /projects/library': () => { throw error } })
    const { user, choose } = renderSheet()
    await choose(pdf())
    await user.click(screen.getByRole('button', { name: 'Upload (1)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('takes the pending item back when the PUT fails, so trying again makes one item', async () => {
    await uploadStarted({ 'POST /projects/library': created, [`DELETE /projects/library/${Q3_ID}`]: () => ({ success: true, deleted: Q3_ID }) })
    xhr.last().fail()
    expect(await screen.findByRole('alert')).toHaveTextContent('The upload stopped: check your connection and try again.')
    expect(fetchApi).toHaveBeenCalledWith(`/projects/library/${Q3_ID}`, { method: 'DELETE' })
    expect(screen.getByRole('button', { name: 'Upload (1)' })).toBeEnabled()
  })

  it('says a file that did not arrive, and keeps going when the pending item cannot be taken back', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await uploadStarted({
      'POST /projects/library': created,
      [`POST /projects/library/${Q3_ID}/uploaded`]: () => { throw new ApiError(409, 'not yet', 'not_uploaded') },
    })
    xhr.last().respond(200)
    expect(await screen.findByRole('alert')).toHaveTextContent('The file did not arrive. Try again.')
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith('Failed to remove a pending library item', expect.any(Error)))
  })

  it('stays open while a file is in flight, and closes with Done once all are uploaded', async () => {
    route({ 'POST /projects/library': created, [`POST /projects/library/${Q3_ID}/uploaded`]: () => ({ item: libraryItem({ status: 'extracting' }) }) })
    const { user, choose, onClose } = renderSheet()
    await choose(pdf())
    await user.click(screen.getByRole('button', { name: 'Upload (1)' }))
    await waitFor(() => expect(xhr.sent).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    xhr.last().respond(200)
    await user.click(await screen.findByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledWith()
  })
})
