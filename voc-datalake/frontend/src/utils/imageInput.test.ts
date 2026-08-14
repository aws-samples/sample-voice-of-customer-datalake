/**
 * The shared image-input helpers, tested directly.
 *
 * They were exercised only transitively through two component suites, which
 * means a failure pointed at a modal rather than at the browser trap the helper
 * exists for. Each case below names that trap: the values these functions judge
 * are browser-supplied, and every one of them has a shape that looks impossible
 * until a real clipboard or a real drop produces it.
 */
import { describe, it, expect } from 'vitest'
import {
  IMAGE_ACCEPT_ATTR, IMAGE_EXTENSIONS_LABEL, IMAGE_MIME_EXTENSIONS, dragLeavesElement,
  isAcceptedImageMime, pastedImages, toArray, withSyntheticName,
} from './imageInput'

/** A clipboard whose `items` are populated, as a copied bitmap produces. */
function clipboardWithItems(files: readonly File[]): DataTransfer {
  const clipboard = {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files: [],
  }
  // The suite hands React a DataTransfer-shaped literal for the same reason: jsdom
  // has no DataTransfer, and only these two properties are ever read.
  return clipboard as unknown as DataTransfer
}

/** A clipboard whose `items` are empty and whose `files` are not. */
function clipboardWithFilesOnly(files: readonly File[]): DataTransfer {
  return { items: [], files } as unknown as DataTransfer
}

describe('isAcceptedImageMime', () => {
  it('accepts exactly the four types Converse can read', () => {
    expect(Object.keys(IMAGE_MIME_EXTENSIONS)).toEqual([
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    ])
    for (const mime of Object.keys(IMAGE_MIME_EXTENSIONS)) {
      expect(isAcceptedImageMime(mime)).toBe(true)
    }
  })

  it('refuses the empty type a dropped folder arrives with', () => {
    // A dropped directory, and a file whose type the OS could not determine, both
    // surface as ''. Object.hasOwn on a bare '' is the case a `.startsWith`
    // implementation would wave through.
    expect(isAcceptedImageMime('')).toBe(false)
  })

  it('refuses an image format the model cannot read, and a document', () => {
    expect(isAcceptedImageMime('image/bmp')).toBe(false)
    expect(isAcceptedImageMime('image/svg+xml')).toBe(false)
    expect(isAcceptedImageMime('application/pdf')).toBe(false)
  })

  it('is not fooled by a prototype key', () => {
    // Object.hasOwn rather than `in` or a truthy lookup: 'constructor' and
    // 'toString' are on every object's prototype chain, and file.type is
    // attacker-influencable in the sense that it comes from outside the app.
    expect(isAcceptedImageMime('constructor')).toBe(false)
    expect(isAcceptedImageMime('toString')).toBe(false)
  })
})

describe('the derived accept attribute and refusal label', () => {
  it('offers every accepted type to the picker', () => {
    for (const mime of Object.keys(IMAGE_MIME_EXTENSIONS)) {
      expect(IMAGE_ACCEPT_ATTR).toContain(mime)
    }
    expect(IMAGE_ACCEPT_ATTR).not.toContain('pdf')
  })

  it('names the four extensions, sorted, with .jpg rather than .jpeg', () => {
    expect(IMAGE_EXTENSIONS_LABEL).toBe('.gif, .jpg, .png, .webp')
  })
})

describe('withSyntheticName', () => {
  it('names a pasted JPEG .jpg, not the .jpeg its MIME subtype suggests', () => {
    // The trap the map exists for: `image/jpeg`.split('/')[1] is 'jpeg', and this
    // app calls that extension .jpg everywhere (resizeImage.ts,
    // IMAGE_CONTENT_TYPE_EXTENSIONS server-side).
    const named = withSyntheticName(new File([new Uint8Array(4)], '', { type: 'image/jpeg' }))

    expect(named.name).toMatch(/^pasted-.+\.jpg$/)
    expect(named.name).not.toContain('.jpeg')
    expect(named.type).toBe('image/jpeg')
  })

  it('gives each accepted type the extension the map names', () => {
    for (const [mime, ext] of Object.entries(IMAGE_MIME_EXTENSIONS)) {
      const named = withSyntheticName(new File([new Uint8Array(1)], '', { type: mime }))
      expect(named.name.endsWith(ext)).toBe(true)
    }
  })

  it('leaves a file that already has a name completely alone', () => {
    // Control: a dropped or picked file has a name, and inventing one would put a
    // filename in front of the user that is not the one they chose.
    const original = new File([new Uint8Array(4)], 'card.png', { type: 'image/png' })

    expect(withSyntheticName(original)).toBe(original)
  })

  it('keeps the bytes', () => {
    // A name-only rewrite that dropped the content would still satisfy every
    // assertion above, and would send an empty image.
    const named = withSyntheticName(new File([new Uint8Array(7)], '', { type: 'image/png' }))

    expect(named.size).toBe(7)
  })
})

describe('pastedImages', () => {
  it('finds a bitmap on a clipboard that populates items', () => {
    const file = new File([new Uint8Array(4)], '', { type: 'image/png' })

    expect(pastedImages(clipboardWithItems([file]))).toEqual([file])
  })

  it('falls back to files when items is empty', () => {
    // Some paste sources populate only `files`. Dropping this branch loses whole
    // browsers, and the loss is silent.
    const file = new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' })

    expect(pastedImages(clipboardWithFilesOnly([file]))).toEqual([file])
  })

  it('ignores the text flavour a copied bitmap is often carried alongside', () => {
    const image = new File([new Uint8Array(4)], '', { type: 'image/png' })
    const clipboard = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => image },
      ],
      files: [],
    } as unknown as DataTransfer

    expect(pastedImages(clipboard)).toEqual([image])
  })

  it('returns nothing for a text-only paste, which is what leaves it untouched', () => {
    // The caller may only preventDefault() once this has found something, so an
    // empty result here IS the "an ordinary paste still pastes" behaviour.
    const clipboard = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer

    expect(pastedImages(clipboard)).toEqual([])
  })

  it('passes a non-accepted IMAGE through so the caller can refuse it out loud', () => {
    // The filter is the image/ prefix, deliberately wider than the accepted four:
    // a silently ignored BMP is indistinguishable from a missing handler.
    const bmp = new File([new Uint8Array(4)], 'shot.bmp', { type: 'image/bmp' })

    expect(pastedImages(clipboardWithItems([bmp]))).toEqual([bmp])
  })

  it('ignores a document flavour, which a Word or Finder copy attaches to text', () => {
    const doc = new File(['PK'], 'persona.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })

    expect(pastedImages(clipboardWithItems([doc]))).toEqual([])
    expect(pastedImages(clipboardWithFilesOnly([doc]))).toEqual([])
  })

  it('tolerates a clipboard that is absent entirely', () => {
    expect(pastedImages(null)).toEqual([])
  })
})

describe('toArray', () => {
  it('converts a live collection, and tolerates absence', () => {
    // FileList and DataTransferItemList are array-LIKE, so Array.from is required
    // before any array method; and `clipboardData.items` is genuinely absent on
    // some sources rather than empty.
    expect(toArray({ length: 2, 0: 'a', 1: 'b' })).toEqual(['a', 'b'])
    expect(toArray(null)).toEqual([])
    expect(toArray(undefined)).toEqual([])
  })
})

describe('dragLeavesElement', () => {
  const zone = document.createElement('div')
  const child = document.createElement('p')
  zone.appendChild(child)
  const outside = document.createElement('div')

  it('is false for a leave towards the zone own child', () => {
    // dragleave bubbles from descendants, so this event arrives while the pointer
    // is still inside the zone. Treating it as a leave flickers the highlight.
    expect(dragLeavesElement({ currentTarget: zone, relatedTarget: child })).toBe(false)
  })

  it('is true for a leave towards something outside', () => {
    expect(dragLeavesElement({ currentTarget: zone, relatedTarget: outside })).toBe(true)
  })

  it('is true when relatedTarget is null, which is the drag leaving the window', () => {
    // Defaulting to false here would leave a zone permanently highlighted after a
    // drag was abandoned off-window.
    expect(dragLeavesElement({ currentTarget: zone, relatedTarget: null })).toBe(true)
    expect(dragLeavesElement({ currentTarget: null, relatedTarget: child })).toBe(true)
  })

  it('is false for the zone itself, which contains() reports as contained', () => {
    expect(dragLeavesElement({ currentTarget: zone, relatedTarget: zone })).toBe(false)
  })
})
