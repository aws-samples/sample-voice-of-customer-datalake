/**
 * The three ways a persona card reaches the import modal: the file picker, a
 * drop on the upload zone, and a paste.
 *
 * WHY IT IS A HOOK RATHER THAN INLINE HANDLERS: only ONE of the three used to
 * work. The zone advertised "Click to upload or drag and drop" while the hidden
 * `<input>` was the only thing that could take a file, and nothing anywhere
 * listened for a paste — so dragging the file or pasting the screenshot did
 * nothing at all, with no error to say why. Fixing that means every path has to
 * converge on the same preparation and the same refusals, which is exactly what
 * three separate inline handlers drift away from.
 *
 * WHAT EVERY PATH NOW DOES, in this order:
 *   1. refuse anything outside the four types Bedrock Converse can read, out
 *      loud, leaving the previous selection intact — a silent refusal is
 *      indistinguishable from the missing handler this replaces;
 *   2. name a nameless bitmap (a paste carries no filename, and the zone renders
 *      that name back as confirmation);
 *   3. run it through resizeImageForUpload, because a retina full-screen
 *      screenshot — the ordinary paste — is several times the per-image Converse
 *      limit, and skipping this ships an import that fails after submission;
 *   4. hand the caller a File carrying the PREPARED bytes, whose `type` is the
 *      prepared content type. The API refuses a blank or non-image `media_type`
 *      before it does any work (lambda/shared/persona_import.py), so the media
 *      type must describe what is actually being sent, never a default.
 */
import {
  useCallback, useEffect, useRef, useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  IMAGE_EXTENSIONS_LABEL, dragLeavesElement, isAcceptedImageMime, pastedImages, toArray,
  withSyntheticName,
} from '../../utils/imageInput'
import { isImagePrepError, resizeImageForUpload } from './resizeImage'

export interface PersonaImageInput {
  /**
   * Localized reason the last attempt was refused (or the note that only the
   * first of several files was used), or null.
   */
  readonly error: string | null
  /** True while an accepted-or-not drag sits over the zone. */
  readonly dragActive: boolean
  readonly onDragEnter: (e: React.DragEvent) => void
  readonly onDragOver: (e: React.DragEvent) => void
  readonly onDragLeave: (e: React.DragEvent) => void
  readonly onDrop: (e: React.DragEvent) => void
  readonly onPickerChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

/**
 * Swallows a drag that MISSES the drop zone, for the modal panel around it.
 *
 * The zone is a fraction of the panel, so most of the modal is a few pixels away
 * from it — and a drop that lands there reaches the browser's default, which
 * NAVIGATES to the dropped file and destroys the modal along with anything
 * already selected. That is the worst outcome in this flow and the one a user
 * cannot tell apart from a crash.
 *
 * Cancel-ONLY, and deliberately not a second drop target: the dashed zone stays
 * the single place where a drop selects something. A plain function rather than
 * part of the hook, because it holds no state and belongs to the panel, which
 * outlives the image step.
 */
export function cancelDragEvent(e: React.DragEvent) {
  e.preventDefault()
}

/**
 * MOUNTED ONLY WHILE THE IMAGE STEP IS SHOWING, which is load-bearing twice
 * over rather than incidental:
 *
 *   - the `error` below is about one attempt at one file. The selection it
 *     described lives in useImportModalState and is cleared when the import type
 *     changes, so an error that outlived the step came back rendered over an
 *     empty zone, describing a file the user had already abandoned. Unmounting is
 *     what makes "no attempt has been made here" the state on arrival, with no
 *     reset to remember;
 *   - the document-level paste listener must not exist for the text step, whose
 *     own paste behaviour is untouched.
 *
 * So the caller renders the section conditionally rather than passing a flag: see
 * ImportPersonaModal, where an `importType !== 'image'` early return INSIDE the
 * section would keep this hook alive and both properties would be lost.
 */
export function usePersonaImageInput({
  onFileChange,
}: {
  readonly onFileChange: (file: File) => void
}): PersonaImageInput {
  const { t } = useTranslation('projectDetail')
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  /**
   * Which attempt is allowed to write state.
   *
   * `prepare` is async and nothing serializes two quick drops, so a slow failure
   * from the first can settle AFTER the second succeeded and pair a good
   * filename with a red refusal. Every attempt takes a ticket and only the
   * newest one may report — the same latest-wins guard a cancellable fetch would
   * need.
   */
  const attempt = useRef(0)

  const prepare = useCallback(async (file: File, notice: string | null) => {
    attempt.current += 1
    const ticket = attempt.current
    // A new attempt invalidates whatever the last one said. Without this a
    // refusal outlives the thing it was about: it is still on screen after a
    // later file was accepted, describing a file the user already abandoned.
    setError(notice)
    // The type is judged on the file as supplied. Refusing here — before a name
    // is synthesized — keeps the message about what the user actually dropped: a
    // nameless non-image would otherwise be reported under an invented `.png`.
    if (!isAcceptedImageMime(file.type)) {
      setError(t('importPersona.errors.unsupportedType', {
        type: file.type || t('importPersona.errors.unknownType'),
        accepted: IMAGE_EXTENSIONS_LABEL,
      }))
      return
    }
    const named = withSyntheticName(file)
    try {
      const prepared = await resizeImageForUpload(named)
      if (ticket !== attempt.current) return
      // `notice`, not null: a multi-file drop's "only the first was used" note is
      // about the accepted file and has to survive its acceptance.
      setError(notice)
      // A File, not the Blob: the caller reads `name` for what it shows the user
      // and `type` for the media_type it sends, and both must describe the
      // prepared bytes rather than the original's.
      onFileChange(new File([prepared.blob], prepared.filename, { type: prepared.contentType }))
    } catch (e: unknown) {
      // A settled attempt that is no longer the newest says nothing: its refusal
      // would otherwise overwrite a good selection made after it started.
      if (ticket !== attempt.current) return
      // Nothing else is cleared on failure, so a bad second attempt cannot throw
      // away a good first one's SELECTION — only the message it left behind.
      if (isImagePrepError(e) && e.failure === 'too-large') {
        setError(t('imageErrors.tooLarge', { name: named.name }))
        return
      }
      setError(t('imageErrors.unreadable', { name: named.name }))
    }
  }, [onFileChange, t])

  /**
   * One persona card per import, so only the first file is taken — the same
   * single-file contract the picker has always had. Taking it SILENTLY is the
   * milder version of the bug being fixed here, though: dropping three
   * screenshots would look like it worked and lose two, so the discard is said
   * out loud. Unreachable from the picker, which has no `multiple`.
   *
   * An empty collection is left completely alone: a drag carrying only text, or
   * a paste carrying only text, is not a failed image upload and must not
   * produce an error.
   */
  const handleFiles = useCallback((files: ArrayLike<File> | null) => {
    const all = toArray(files)
    const [first] = all
    if (!first) return
    void prepare(first, all.length > 1 ? t('importPersona.errors.onlyFirstImage') : null)
  }, [prepare, t])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    // preventDefault on enter/over is what makes this a drop target at all:
    // without it the browser keeps its default and NAVIGATES to the dropped
    // file, replacing the app.
    e.preventDefault()
    e.stopPropagation()
    setDragActive(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // dragleave bubbles from the zone's own icon and labels, so a drag moving
    // across them reports leaving a zone the pointer is still inside — the
    // highlight would flicker off and back on with every child crossed.
    if (!dragLeavesElement(e)) return
    setDragActive(false)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    handleFiles(e.dataTransfer?.files ?? null)
  }, [handleFiles])

  /**
   * WHY document AND NOT a React onPaste on the panel: React delegates, so a
   * handler on the panel only fires for a paste whose target is inside it —
   * and nothing focuses the panel when the modal opens. Focus stays on the
   * "Import Persona" trigger in PersonasTab, or lands on <body>, so the ordinary
   * "open the modal, press ⌘V" gesture — the whole point of the hint this change
   * adds — would have pasted into nothing at all.
   *
   * It is still narrowly scoped: this hook is mounted only while the image step is
   * showing, so the listener does not exist for the text step at all, and the
   * no-file early return means an ordinary text paste anywhere keeps its default,
   * including into the persona textarea.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const images = pastedImages(e.clipboardData)
      // A paste carrying no image — ordinary copied text, or the non-image file
      // flavours Word/Outlook/Finder attach to a text copy — is left untouched,
      // default and all. This early return is why pasting into the persona
      // textarea still behaves like a paste, and it is the reason
      // preventDefault() happens only below it.
      if (images.length === 0) return
      e.preventDefault()
      handleFiles(images)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [handleFiles])

  const onPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files)
    // Clearing the value lets the same file be chosen twice in a row: without
    // it, re-picking the file just refused emits no change event at all.
    e.target.value = ''
  }, [handleFiles])

  return {
    error,
    dragActive,
    onDragEnter,
    onDragOver: onDragEnter,
    onDragLeave,
    onDrop,
    onPickerChange,
  }
}
