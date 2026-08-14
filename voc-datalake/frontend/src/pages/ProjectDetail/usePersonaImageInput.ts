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
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IMAGE_EXTENSIONS_LABEL, isAcceptedImageMime, pastedFiles, toArray, withSyntheticName,
} from '../../utils/imageInput'
import { isImagePrepError, resizeImageForUpload } from './resizeImage'

export interface PersonaImageInput {
  /** Localized reason the last attempt was refused, or null. */
  readonly error: string | null
  /** True while an accepted-or-not drag sits over the zone. */
  readonly dragActive: boolean
  readonly onDragEnter: (e: React.DragEvent) => void
  readonly onDragOver: (e: React.DragEvent) => void
  readonly onDragLeave: (e: React.DragEvent) => void
  readonly onDrop: (e: React.DragEvent) => void
  readonly onPaste: (e: React.ClipboardEvent) => void
  readonly onPickerChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export function usePersonaImageInput({
  enabled,
  onFileChange,
}: {
  /** False for the text-import type, whose own paste behaviour is untouched. */
  readonly enabled: boolean
  readonly onFileChange: (file: File) => void
}): PersonaImageInput {
  const { t } = useTranslation('projectDetail')
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const prepare = useCallback(async (file: File) => {
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
      setError(null)
      // A File, not the Blob: the caller reads `name` for what it shows the user
      // and `type` for the media_type it sends, and both must describe the
      // prepared bytes rather than the original's.
      onFileChange(new File([prepared.blob], prepared.filename, { type: prepared.contentType }))
    } catch (e: unknown) {
      // Nothing is cleared on failure, so a bad second attempt cannot throw away
      // a good first one.
      if (isImagePrepError(e) && e.failure === 'too-large') {
        setError(t('importPersona.errors.imageTooLarge', { name: named.name }))
        return
      }
      setError(t('importPersona.errors.imageUnreadable', { name: named.name }))
    }
  }, [onFileChange, t])

  /**
   * One persona card per import, so only the first file is taken — the same
   * single-file contract the picker has always had.
   *
   * An empty collection is left completely alone: a drag carrying only text, or
   * a paste carrying only text, is not a failed image upload and must not
   * produce an error.
   */
  const handleFiles = useCallback((files: ArrayLike<File> | null) => {
    const [first] = toArray(files)
    if (!first) return
    void prepare(first)
  }, [prepare])

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
    setDragActive(false)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    handleFiles(e.dataTransfer?.files ?? null)
  }, [handleFiles])

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    if (!enabled) return
    const files = pastedFiles(e.clipboardData)
    // A paste carrying no file at all — ordinary copied text — is left
    // untouched, default and all. This early return is why pasting into the
    // persona textarea still behaves like a paste, and it is the reason
    // preventDefault() happens only below it.
    if (files.length === 0) return
    e.preventDefault()
    handleFiles(files)
  }, [enabled, handleFiles])

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
    onPaste,
    onPickerChange,
  }
}
