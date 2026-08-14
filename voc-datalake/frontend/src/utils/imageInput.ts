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
 *
 * The prefix is also the CEILING, not just the floor: copying from Word, Excel
 * or Outlook, and copying a file in Finder/Explorer, put non-image file flavours
 * (`text/rtf`, `application/vnd.*`, an arbitrary file) on the clipboard next to
 * the text the user thinks they copied. Widening this to every file would turn
 * those ordinary text pastes into a cancelled paste plus a red refusal about a
 * file the user never chose, which is a worse answer than ignoring a flavour they
 * never meant to send. A file DROP is unambiguous by comparison, and is still
 * refused out loud by the callers that take one.
 */
export function pastedImages(clipboard: DataTransfer | null): readonly File[] {
  return clipboardFiles(clipboard, isImageType)
}

/**
 * Whether a `dragleave` means the pointer actually left `currentTarget`.
 *
 * `dragenter`/`dragleave` fire on descendants and bubble, so dragging across a
 * drop zone's own icon and labels delivers a `dragleave` for the zone while the
 * pointer is still inside it — the highlight drops and is re-set by the next
 * `dragover`, a visible flicker.  A leave whose `relatedTarget` is still inside
 * the zone is therefore not a leave.
 *
 * `relatedTarget` is null when the drag left the window entirely, which IS a real
 * leave — hence the default of true, without which an abandoned drag would leave
 * a zone highlighted forever. instanceof rather than casts: both values are
 * browser-supplied, and this codebase's lint bans type assertions.
 */
export function dragLeavesElement(event: {
  readonly currentTarget: EventTarget | null
  readonly relatedTarget: EventTarget | null
}): boolean {
  const { currentTarget, relatedTarget } = event
  if (!(currentTarget instanceof Node) || !(relatedTarget instanceof Node)) return true
  return !currentTarget.contains(relatedTarget)
}

/**
 * Whether a drag is carrying FILES rather than text.
 *
 * The distinction decides whether cancelling the drag is a fix or a new bug. A
 * file drag that reaches the browser's default NAVIGATES to the file, so it has
 * to be cancelled wherever it can land. A TEXT drag's default is how a browser
 * inserts dragged text at the caret of a `<textarea>`, so cancelling it at an
 * ancestor silently destroys that insertion — the same "the UI took the gesture
 * and nothing happened" defect, one element out.
 *
 * `'Files'` is the type the drag-and-drop spec puts on `types` for a file drag,
 * and it is what every browser reports. `Array.from` because `types` is a
 * read-only array-like, and no assertion, which this codebase's lint bans.
 *
 * NO VENDOR BRANCH IS NEEDED, and adding one is the tempting wrong edit. Firefox
 * additionally exposes `application/x-moz-file` in `types` for a file drag, but
 * always ALONGSIDE the spec-mandated `'Files'` entry, never instead of it — so
 * checking `'Files'` alone already covers it. Loosening this predicate (an `||`
 * for a vendor type, or "any non-text type") re-enables the browser default this
 * guard exists to suppress: a file drop that reaches it NAVIGATES away from the
 * app, destroying the modal and anything already selected.
 */
export function dragCarriesFiles(event: {
  readonly dataTransfer: Pick<DataTransfer, 'types'> | null
}): boolean {
  return toArray(event.dataTransfer?.types).includes('Files')
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
