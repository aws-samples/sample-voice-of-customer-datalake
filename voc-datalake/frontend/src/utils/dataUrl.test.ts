/**
 * @fileoverview dataUrl: bytes and UTF-8 text become `data:<type>;base64,` URLs, also past one chunk.
 */
import { describe, expect, it } from 'vitest'
import { bytesToDataUrl, textToDataUrl } from './dataUrl'

const decode = (url: string): Uint8Array =>
  Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0))

describe('bytesToDataUrl', () => {
  it('encodes the bytes under the given type', () => {
    expect(bytesToDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBe('data:image/png;base64,iVBORw==')
  })

  it('round-trips more bytes than one fromCharCode chunk', () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, index) => index % 256)
    expect(decode(bytesToDataUrl(bytes, 'image/png'))).toStrictEqual(bytes)
  })

  it('encodes no bytes as an empty payload', () => {
    expect(bytesToDataUrl(new Uint8Array(), 'image/gif')).toBe('data:image/gif;base64,')
  })
})

describe('textToDataUrl', () => {
  it('encodes the text as UTF-8', () => {
    const url = textToDataUrl('<svg><title>Äir ✈</title></svg>', 'image/svg+xml')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(new TextDecoder().decode(decode(url))).toBe('<svg><title>Äir ✈</title></svg>')
  })
})
