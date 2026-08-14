/**
 * @fileoverview Shared helpers for the three ways a user supplies an image:
 * the file picker, a drag-and-drop, and a paste.
 * @module utils/imageInput
 *
 * LIFTED, NOT COPIED. These were module-private in
 * `pages/ProjectDetail/ProductDocsUpload.tsx`, which was the only pane that
 * accepted a pasted image. The persona-import modal now needs exactly the same
 * behaviour, and the traps they exist for are properties of the browser and of
 * this platform's naming rather than of either pane:
 *
 *   - a pasted bitmap has NO filename, so anything rendering `file.name`
 *     shows a blank row;
 *   - `image/jpeg`'s MIME subtype is `jpeg` while every filename in this app
 *     for that type ends `.jpg`, so neither can be derived from the other by
 *     string surgery;
 *   - `clipboardData.items` is not populated by every paste source, so `files`
 *     has to stay as a fallback.
 *
 * A second copy of any of those would drift, and the drift is silent.
 */

/**
 * The image content types this platform accepts, mapped to the file extension
 * it names them with.
 *
 * Exactly the four formats Bedrock Converse can read. The server enforces the
 * same set — `CONVERSE_IMAGE_FORMATS` in `lambda/shared/image_limits.py`,
 * applied to persona import by `lambda/shared/persona_import.py`, which refuses
 * an image whose `media_type` is absent, blank or outside this set. A client
 * filter is therefore a convenience, not the guard.
 *
 * The values are EXTENSIONS, not Converse `format` strings: Converse calls the
 * second one `jpeg` and rejects `jpg`, which is why the two maps are kept apart
 * on the server as well.
 */
export const IMAGE_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
} as const

export type AcceptedImageMime = keyof typeof IMAGE_MIME_EXTENSIONS

/**
 * Narrows a MIME string to a key of IMAGE_MIME_EXTENSIONS.
 *
 * A type guard rather than a cast, because the values checked here are
 * browser-supplied: `file.type` can be anything, and it is `''` for a dropped
 * folder and for files whose type the OS could not determine.
 */
export function isAcceptedImageMime(value: string): value is AcceptedImageMime {
  return Object.hasOwn(IMAGE_MIME_EXTENSIONS, value)
}

/** `accept` for a picker that takes only these images. */
export const IMAGE_ACCEPT_ATTR = Object.keys(IMAGE_MIME_EXTENSIONS).join(',')

/**
 * Extension list for a user-facing refusal, derived from the map so adding an
 * accepted type cannot leave the message naming a set it no longer describes.
 */
export const IMAGE_EXTENSIONS_LABEL = [...new Set(Object.values(IMAGE_MIME_EXTENSIONS))]
  .sort((a, b) => a.localeCompare(b))
  .join(', ')

/** Tolerates a clipboard/file collection that is absent rather than empty. */
export function toArray<T>(source: ArrayLike<T> | undefined | null): readonly T[] {
  return source ? Array.from(source) : []
}

/**
 * Files on a clipboard whose type passes `accept`.
 *
 * Prefers `items` (the shape every browser fills for a copied bitmap) and falls
 * back to `files`, which is the only one populated for some paste sources.
 * BOTH paths are kept on purpose — dropping either loses whole browsers.
 *
 * The `accept` predicate is applied to the `items` pass as well as the `files`
 * one, so a clipboard carrying a text flavour alongside a bitmap still finds the
 * bitmap in `files` when `items` yielded nothing of interest.
 */
function clipboardFiles(
  clipboard: DataTransfer | null,
  accept: (type: string) => boolean,
): readonly File[] {
  if (!clipboard) return []
  const fromItems = toArray(clipboard.items)
    .filter((item) => item.kind === 'file' && accept(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (fromItems.length > 0) return fromItems
  return toArray(clipboard.files).filter((file) => accept(file.type))
}

function isImageType(type: string): boolean {
  return type.startsWith('image/')
}

/**
 * Images carried by a paste.
 *
 * Returning empty is what lets a text paste through untouched: a caller must
 * only `preventDefault()` once this has found something.
 *
 * Filters on the `image/` prefix rather than on the accepted four, so a pasted
 * BMP reaches the caller and can be refused out loud — a paste that silently
 * does nothing is indistinguishable from a missing handler.
 */
export function pastedImages(clipboard: DataTransfer | null): readonly File[] {
  return clipboardFiles(clipboard, isImageType)
}

/**
 * Every file carried by a paste, image or not.
 *
 * The distinction from `pastedImages` is what lets a caller tell "this paste
 * carried nothing but text, leave it entirely alone" apart from "this paste
 * carried a PDF, say why it cannot be used" — two answers a user needs to be
 * able to tell apart, and the reason a refusal is not silence.
 */
export function pastedFiles(clipboard: DataTransfer | null): readonly File[] {
  return clipboardFiles(clipboard, () => true)
}

/**
 * A pasted bitmap has no filename. Synthesize one — a name is what the user
 * reads back to confirm what they just supplied, and rendering `''` gives a
 * blank row that looks like nothing happened.
 *
 * The extension comes from IMAGE_MIME_EXTENSIONS, never from the MIME subtype:
 * `image/jpeg`.split('/') would produce `.jpeg`, while this app names that
 * extension `.jpg` everywhere (here, IMAGE_EXTENSIONS in resizeImage.ts,
 * IMAGE_CONTENT_TYPE_EXTENSIONS server-side).
 */
export function withSyntheticName(file: File): File {
  if (file.name) return file
  const ext = isAcceptedImageMime(file.type) ? IMAGE_MIME_EXTENSIONS[file.type] : '.png'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return new File([file], `pasted-${stamp}${ext}`, { type: file.type })
}
