/**
 * @fileoverview /company → Design system → logo upload: an SVG logo is converted to PNG in the
 * browser and only the PNG is uploaded; a conversion failure is explained and nothing is uploaded;
 * PNG and JPEG upload unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { designCalls, registerDesignSectionHooks, renderDesignSection } from '@test/designSectionHarness'
import { installFetchMock } from '@test/fetch-mock'
import { SvgConversionError } from '../../utils/svgToPng'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

// jsdom has no canvas: the converter itself is covered by utils/svgToPng.test.ts.
const convert = vi.hoisted(() => vi.fn<(file: File) => Promise<File>>())
vi.mock('../../utils/svgToPng', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/svgToPng')>(),
  svgToPng: (file: File) => convert(file),
}))

const DESIGN = { tokens: { colors: [], typography: [], spacing: [], radius: [] }, guidelines: '', references: [], integrations: { figma: false, github: false } }
const UPLOAD_URL = 'https://uploads.example.com/logo'

registerDesignSectionHooks()
afterEach(() => {
  convert.mockReset()
  vi.unstubAllGlobals()
})

function renderLogo() {
  const createUpload = vi.fn((_body: unknown) => ({ upload: { url: UPLOAD_URL, headers: { 'Content-Type': 'image/png' } } }))
  renderDesignSection({ 'GET /settings/design-system': () => DESIGN, 'POST /settings/design-system/logo': createUpload })
  const put = installFetchMock()
  put.mockResolvedValue({ ok: true, status: 200 })
  return { createUpload, put }
}

const picker = () => screen.findByLabelText('Upload logo')
const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'mark.svg', { type: 'image/svg+xml' })

describe('an SVG logo', () => {
  const png = new File([new Uint8Array(2048)], 'mark.png', { type: 'image/png' })

  async function uploadSvg() {
    convert.mockResolvedValue(png)
    const routes = renderLogo()
    await userEvent.upload(await picker(), svg)
    await waitFor(() => expect(routes.put).toHaveBeenCalledTimes(1))
    return routes
  }

  it('asks for a PNG upload target sized like the PNG converted in the browser', async () => {
    const { createUpload } = await uploadSvg()
    expect(convert).toHaveBeenCalledWith(svg)
    expect(createUpload).toHaveBeenCalledWith({ content_type: 'image/png', size_bytes: 2048 })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('PUTs the PNG, never the SVG', async () => {
    const { put } = await uploadSvg()
    expect(put.mock.calls[0]?.[0]).toBe(UPLOAD_URL)
    expect(put.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT', body: png })
  })

  it('that cannot be converted is explained and nothing is uploaded', async () => {
    convert.mockRejectedValue(new SvgConversionError('not_converted'))
    const { put } = renderLogo()
    await userEvent.upload(await picker(), svg)
    expect(await screen.findByRole('alert')).toHaveTextContent('This SVG could not be converted in your browser. Export it as PNG and upload that.')
    expect(designCalls('POST /settings/design-system/logo')).toStrictEqual([])
    expect(put).not.toHaveBeenCalled()
  })

  it('over 1 MB is named in the message', async () => {
    convert.mockRejectedValue(new SvgConversionError('too_large'))
    renderLogo()
    await userEvent.upload(await picker(), svg)
    expect(await screen.findByRole('alert')).toHaveTextContent('mark.svg is larger than 1 MB. An SVG logo can be up to 1 MB.')
  })

  it('is offered by the picker, and the hint says it is converted in the browser', async () => {
    renderLogo()
    const input = await picker()
    const accepted = new Set(input.getAttribute('accept')?.split(','))
    expect(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', '.svg'].filter((type) => !accepted.has(type))).toStrictEqual([])
    expect(input).toHaveAccessibleDescription('PNG, JPEG, WebP or SVG (SVG is converted to PNG in your browser).')
  })
})

describe('a PNG or JPEG logo', () => {
  it.each([
    ['logo.png', 'image/png'],
    ['logo.jpg', 'image/jpeg'],
  ])('%s uploads unchanged', async (name, type) => {
    const file = new File([new Uint8Array(512)], name, { type })
    const { createUpload, put } = renderLogo()
    await userEvent.upload(await picker(), file)
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(convert).not.toHaveBeenCalled()
    expect(createUpload).toHaveBeenCalledWith({ content_type: type, size_bytes: 512 })
    expect(put.mock.calls[0]?.[1]).toMatchObject({ body: file })
  })
})
