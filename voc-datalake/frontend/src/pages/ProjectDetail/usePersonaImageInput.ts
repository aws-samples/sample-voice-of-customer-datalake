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
  IMAGE_EXTENSIONS_LABEL, dragCarriesFiles, dragLeavesElement, isAcceptedImageMime, pastedImages,
  toArray, withSyntheticName,
} from '../../utils/imageInput'
import { isImagePrepError, resizeImageForUpload } from './resizeImage'

/**
 * What the zone has to say about the last attempt.
 *
 * The `kind` is not decoration. A refusal and the "only the first image was
 * used" note are both single-line messages under the zone, but one describes a
 * failure and the other describes something that WORKED — rendering the second
 * as red text in an assertive `role="alert"` tells a screen-reader user their
 * successful drop was an error, and tells everyone else the same in colour. One
 * slot with a severity keeps them distinguishable without a second element to
 * arbitrate between when both would apply: a refusal simply replaces the notice.
 */
export interface PersonaImageMessage {
  readonly text: string
  readonly kind: 'error' | 'notice'
}

export interface PersonaImageInput {
  /**
   * Why the last attempt was refused, or the note that only the first of several
   * files was used, or null. Carries its own severity — see PersonaImageMessage.
   */
  readonly message: PersonaImageMessage | null
  /** True while an accepted-or-not drag sits over the zone. */
  readonly dragActive: boolean
  readonly onDragEnter: (e: React.DragEvent) => void
  readonly onDragOver: (e: React.DragEvent) => void
  readonly onDragLeave: (e: React.DragEvent) => void
  readonly onDrop: (e: React.DragEvent) => void
  readonly onPickerChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

/**
 * Swallows a FILE drag that misses the drop zone, for the modal around it.
 *
 * The zone is a fraction of the panel, and the panel is a fraction of the
 * viewport the backdrop covers — so nearly everything on screen while this modal
 * is open is a few pixels off the only element that wanted the drop. A file drop
 * landing there reaches the browser's default, which NAVIGATES to the dropped
 * file and destroys the modal along with anything already selected. That is the
 * worst outcome in this flow and the one a user cannot tell apart from a crash,
 * so it is cancelled on the BACKDROP, which is an ancestor of everything else the
 * modal renders.
 *
 * ONLY file drags, which is the whole reason for the guard. A text drag's default
 * is how a browser inserts dragged text at the caret of the persona textarea, and
 * that textarea is a descendant of the same backdrop: cancelling every drag here
 * would silently swallow the insertion — the identical "the UI took the gesture
 * and nothing happened" defect this change exists to remove, one element out.
 *
 * Cancel-ONLY, and deliberately not a second drop target: the dashed zone stays
 * the single place where a drop selects something. A plain function rather than
 * part of the hook, because it holds no state and belongs to the backdrop, which
 * outlives the image step.
 */
export function cancelFileDragEvent(e: React.DragEvent) {
  if (!dragCarriesFiles(e)) return
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
  const [message, setMessage] = useState<PersonaImageMessage | null>(null)
  const [dragActive, setDragActive] = useState(false)

  /** A refusal: red, and announced assertively, because something failed. */
  const refuse = useCallback((text: string) => setMessage({ text, kind: 'error' }), [])

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

  const prepare = useCallback(async (file: File, notice: PersonaImageMessage | null) => {
    attempt.current += 1
    const ticket = attempt.current
    // A new attempt invalidates whatever the last one said. Without this a
    // refusal outlives the thing it was about: it is still on screen after a
    // later file was accepted, describing a file the user already abandoned.
    setMessage(notice)
    // The type is judged on the file as supplied. Refusing here — before a name
    // is synthesized — keeps the message about what the user actually dropped: a
    // nameless non-image would otherwise be reported under an invented `.png`.
    if (!isAcceptedImageMime(file.type)) {
      // A refusal REPLACES the notice: if a multi-file drop's first file is also
      // unreadable, the failure is the thing the user needs to read.
      refuse(t('importPersona.errors.unsupportedType', {
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
      setMessage(notice)
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
        refuse(t('imageErrors.tooLarge', { name: named.name }))
        return
      }
      refuse(t('imageErrors.unreadable', { name: named.name }))
    }
  }, [onFileChange, refuse, t])

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
    // A NOTICE, not an error: the first file was taken, so this reports what
    // happened rather than a failure, and must not be announced as one.
    void prepare(first, all.length > 1
      ? { text: t('importPersona.errors.onlyFirstImage'), kind: 'notice' }
      : null)
  }, [prepare, t])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    // FILES ONLY, and both halves of this matter. preventDefault on enter/over is
    // what MAKES an element a drop target, so running it for a text drag has the
    // zone volunteer for something onDrop then throws away: handleFiles gets an
    // empty dataTransfer.files and returns silently — the "gesture taken, nothing
    // happened" defect this whole change exists to remove. Left ungated, the
    // browser keeps its "you cannot drop that here" cursor, which is the honest
    // signal. And setDragActive would paint the purple "this zone is holding
    // something" highlight for a drop that cannot be accepted.
    if (!dragCarriesFiles(e)) return
    // For a file drag it is required: without it the browser keeps its default
    // and NAVIGATES to the dropped file, replacing the app.
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
   * Unmarks the zone when a drag ENDS anywhere other than on it.
   *
   * The zone's own `onDragLeave` and `onDrop` are not enough. A drag that enters
   * the zone and is then released over the footer, the info box or the dimmed
   * backdrop fires no `dragleave` for the zone at all — the browser does not
   * report leaving an element the drag left by being dropped elsewhere — so the
   * purple highlight stayed on until the modal was closed, advertising a state
   * that was not true.
   *
   * On document rather than as a handler the caller puts on the backdrop, because
   * the cancelling ancestor is the backdrop and the backdrop is rendered ABOVE
   * this hook's owner: FileUploadSection holds the hook precisely so leaving the
   * image step unmounts it, and lifting the hook to reach the backdrop would give
   * that back. `dragend` covers a drag abandoned outside the window entirely.
   */
  useEffect(() => {
    const clear = () => setDragActive(false)
    document.addEventListener('drop', clear)
    document.addEventListener('dragend', clear)
    return () => {
      document.removeEventListener('drop', clear)
      document.removeEventListener('dragend', clear)
    }
  }, [])

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
   *
   * WHAT A document LISTENER CANNOT KNOW is whether something else is on top of
   * the modal, so it is worth saying why nothing is. ProjectDetail renders every
   * modal wrapper as a sibling on independent state, and no state machine makes
   * them exclusive — what does is this modal's own `fixed inset-0` backdrop, which
   * covers the viewport and leaves every trigger behind it unclickable while it is
   * open. The other paste handlers on this page (ProductDocsUpload's pane,
   * ChatTab's attachments) live in other tabs, behind the same backdrop. So the
   * exclusivity is a CONSEQUENCE of the overlay rather than something enforced:
   * anything that could raise a surface ABOVE this one — a toast with a paste
   * target, a second overlay at a higher z-index — would need this listener to
   * check it is still topmost, or to move back to the panel with a focus trap.
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
    message,
    dragActive,
    onDragEnter,
    onDragOver: onDragEnter,
    onDragLeave,
    onDrop,
    onPickerChange,
  }
}
