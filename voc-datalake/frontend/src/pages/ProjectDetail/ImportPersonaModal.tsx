/**
 * ImportPersonaModal - Modal for importing personas from an image or pasted text
 *
 * PDF USED TO BE OFFERED HERE and could not work. Nothing in this platform
 * extracts text from a PDF, so the file was never read: the job handed the model
 * a placeholder sentence instead and the model invented a persona from it, with
 * nothing in this UI to say so. A button that cannot work is the defect the user
 * actually meets, so the affordance is gone until a PDF extractor exists. The
 * API (lambda/api/projects_handler.py) and the job Lambda refuse `pdf` too — the
 * three layers are independent, because a UI that stops offering something does
 * not stop an old queued job or a hand-rolled caller.
 */
import clsx from 'clsx'
import {
  Upload, Image, FileText, CheckCircle, X, Loader2, AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IMAGE_ACCEPT_ATTR } from '../../utils/imageInput'
import { cancelFileDragEvent, usePersonaImageInput } from './usePersonaImageInput'

type ImportType = 'image' | 'text'

// Only 'image' takes a file, so this is no longer a per-type choice. These four
// are exactly the formats Bedrock Converse can read, and the API enforces the
// same set (shared/persona_import.py, via shared/image_limits.py) — the picker
// filter is a convenience, not the guard. The hint the user reads comes from
// `importPersona.imageFormats`.
//
// Derived from the shared map (utils/imageInput.ts) rather than written out, so
// the picker, the drop handler and the paste handler cannot end up accepting
// three different sets.
const ACCEPTED_FILE_TYPES = IMAGE_ACCEPT_ATTR

// RETAINED DEAD KEYS, on purpose: `importPersona.pdf`, `pdfDesc`, `pdfOnly`,
// `uploadPdf` and `importTypePdf` are still in all eight catalogues, already
// translated, and unused until PDF extraction lands (tracked with the PDF work,
// not here). i18n:check reports them as extra, which is informational — deleting
// them would mean re-translating five strings later for no gain now.

interface ImportPersonaModalProps {
  readonly importType: ImportType
  readonly importContent: string
  readonly importFileName: string
  readonly importMediaType: string
  readonly isImporting: boolean
  readonly onTypeChange: (type: ImportType) => void
  readonly onContentChange: (content: string) => void
  readonly onFileChange: (file: File) => void
  readonly onClose: () => void
  readonly onImport: () => void
}

// Import type button component
function ImportTypeButton({
  icon,
  label,
  description,
  isSelected,
  onClick,
}: Readonly<{
  icon: typeof Image
  label: string
  description: string
  isSelected: boolean
  onClick: () => void
}>) {
  const IconElement = icon
  return (
    <button
      onClick={onClick}
      className={clsx(
        'p-4 rounded-lg border text-center',
        isSelected ? 'bg-purple-50 border-purple-300' : 'bg-white border-gray-200 hover:border-purple-200',
      )}
    >
      <IconElement size={24} className="mx-auto mb-2 text-purple-500" />
      <div className="font-medium">{label}</div>
      <div className="text-xs text-gray-500">{description}</div>
    </button>
  )
}

/**
 * The dropzone's border/background for its three states.
 *
 * The drag-over state deliberately reuses the populated state's purple family
 * rather than introducing a colour: it is the same "this zone is holding
 * something" signal one moment earlier, and a darker border is what distinguishes
 * it (the same relationship ProductDocsUpload's zone uses for its own hover and
 * drag states).
 */
function zoneStyle(dragActive: boolean, hasFile: boolean): string {
  if (dragActive) return 'border-purple-500 bg-purple-50'
  if (hasFile) return 'border-purple-300 bg-purple-50'
  return 'border-gray-300 hover:border-purple-300'
}

/**
 * File upload section.
 *
 * Owns the image-input hook, and is rendered by the parent ONLY for the image
 * type rather than returning null for the others. That is what makes leaving the
 * image step unmount the hook, and it is load-bearing: a refusal is about one
 * attempt at one file, and the selection it describes is cleared by
 * handleTypeChange, so an error that survived the step came back rendered over an
 * empty zone. Unmounting also takes the document-level paste listener with it.
 */
function FileUploadSection({
  importFileName,
  onFileChange,
}: Readonly<{
  importFileName: string
  onFileChange: (file: File) => void
}>) {
  const { t } = useTranslation('projectDetail')
  // All three input paths — picker, drop, paste — go through this, so they cannot
  // disagree about what is accepted or about how an image is prepared.
  const imageInput = usePersonaImageInput({ onFileChange })

  return (
    <div>
      <h3 className="font-medium mb-3">{t('importPersona.uploadImage')}</h3>
      <label className="block">
        {/*
          The drag handlers sit on the VISIBLE div, not on the input: the input is
          `hidden`, so it has no box to drop on and never sees a DragEvent. A
          <label> wrapping a hidden input buys click-to-open and nothing else,
          which is exactly why the advertised "or drag and drop" did nothing.

          preventDefault on enter/over (in the hook) is not decoration — without
          it the browser's default wins and NAVIGATES to the dropped file,
          discarding the whole modal.
        */}
        <div
          // A stable hook for the tests, so a restyle of the zone (a shade, a
          // switch to `outline`, a utility rename) cannot fail as if the drop
          // handlers broke. The classes below stay the actual styling.
          data-testid="persona-dropzone"
          data-drag-active={imageInput.dragActive}
          className={clsx(
            'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
            zoneStyle(imageInput.dragActive, importFileName !== ''),
          )}
          onDragEnter={imageInput.onDragEnter}
          onDragOver={imageInput.onDragOver}
          onDragLeave={imageInput.onDragLeave}
          onDrop={imageInput.onDrop}
        >
          {importFileName === '' ? (
            <div>
              <Upload size={32} className="mx-auto mb-2 text-gray-400" />
              <p className="text-gray-600">{t('importPersona.clickToUpload')}</p>
              <p className="text-sm text-gray-400 mt-1">{t('importPersona.imageFormats')}</p>
            </div>
          ) : (
            <div>
              <CheckCircle size={32} className="mx-auto mb-2 text-purple-500" />
              <p className="font-medium text-purple-700">{importFileName}</p>
              <p className="text-sm text-gray-500 mt-1">{t('importPersona.clickToChange')}</p>
            </div>
          )}
        </div>
        <input
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          onChange={imageInput.onPickerChange}
        />
      </label>
      {/* Paste is the third way in, and nothing in the zone said so. */}
      <p className="mt-2 text-xs text-gray-400">{t('importPersona.pasteScreenshotHint')}</p>
      {/*
        One slot, two severities. A refusal is red, carries the alert icon and is
        announced assertively through role="alert", because something failed and
        the user has to act. The "only the first image was used" notice describes a
        drop that WORKED: rendering it the same way told a screen-reader user their
        successful drop was an error and interrupted them to say so, so it reads as
        neutral gray under role="status" — still announced, politely, and still in
        the same place so it cannot be missed. The hook guarantees only one of the
        two is ever live (a refusal replaces the notice).
      */}
      {imageInput.message !== null && (
        imageInput.message.kind === 'error' ? (
          <div role="alert" className="mt-2 text-xs text-red-600 inline-flex items-center gap-1">
            <AlertCircle size={12} /> {imageInput.message.text}
          </div>
        ) : (
          <div role="status" className="mt-2 text-xs text-gray-500">
            {imageInput.message.text}
          </div>
        )
      )}
    </div>
  )
}

// Text input section component
function TextInputSection({
  importType,
  importContent,
  onContentChange,
}: Readonly<{
  importType: ImportType
  importContent: string
  onContentChange: (content: string) => void
}>) {
  // `importPersona.pasteContent` and `pastePlaceholder` have been in all eight
  // catalogues, translated, the whole time these two strings were hardcoded
  // English — so every non-English user read them in English. Reading the keys is
  // the entire fix; the English values are unchanged.
  const { t } = useTranslation('projectDetail')
  if (importType !== 'text') return null

  return (
    <div>
      <h3 className="font-medium mb-3">{t('importPersona.pasteContent')}</h3>
      <textarea
        value={importContent}
        onChange={(e) => onContentChange(e.target.value)}
        placeholder={t('importPersona.pastePlaceholder')}
        rows={10}
        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
      />
    </div>
  )
}

export default function ImportPersonaModal({
  importType,
  importContent,
  importFileName,
  isImporting,
  onTypeChange,
  onContentChange,
  onFileChange,
  onClose,
  onImport,
}: ImportPersonaModalProps) {
  const { t } = useTranslation('projectDetail')

  return (
    // The BACKDROP swallows file drags that miss the dashed zone, not the panel.
    // This div covers the viewport while the modal is open, and the dimmed area
    // outside the small centred panel is the region a user aiming at the zone is
    // most likely to miss; a file drop there reaches the browser's default, which
    // NAVIGATES to the dropped file and takes the modal — and any image already
    // chosen — with it. Being an ancestor of the panel, one pair of handlers here
    // covers both. Cancel-only on purpose: the zone stays the single place where a
    // drop selects something. Only FILE drags are cancelled, so a text drag into
    // the persona textarea keeps the default that inserts it; see
    // cancelFileDragEvent.
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-testid="persona-import-backdrop"
      onDragOver={cancelFileDragEvent}
      onDrop={cancelFileDragEvent}
    >
      {/*
        Paste is NOT handled here. A React onPaste is delegated, so it fires only
        for a paste whose target is inside this subtree, and nothing focuses the
        panel on open — the ordinary "open the modal, press ⌘V" gesture targets
        <body> and would have been a no-op. The hook listens on document while the
        image step is showing instead; see the WHY there.
      */}
      <div
        className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden"
        // A stable hook for the tests, so the panel is not located through the
        // `max-w-2xl` layout utility: widening the modal is not a behaviour change
        // and must not fail a test about drop cancellation.
        data-testid="persona-import-panel"
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{t('importPersona.title')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-6">
          {/* Import Type Selection */}
          <div>
            <h3 className="font-medium mb-3">{t('importPersona.importFrom')}</h3>
            <div className="grid grid-cols-2 gap-3">
              {/* A PDF button used to sit here. The `importPersona.pdf` and
                  `importPersona.pdfDesc` keys are deliberately LEFT IN all eight
                  locale catalogues, ready for when PDF returns: an unused key is
                  informational in `npm run i18n:check`, whereas editing eight
                  catalogues to delete two keys risks moving that gate's counts
                  for no gain. */}
              <ImportTypeButton icon={Image} label={t('importPersona.image')} description={t('importPersona.imageDesc')} isSelected={importType === 'image'} onClick={() => onTypeChange('image')} />
              <ImportTypeButton icon={FileText} label={t('importPersona.text')} description={t('importPersona.textDesc')} isSelected={importType === 'text'} onClick={() => onTypeChange('text')} />
            </div>
          </div>

          {/* Rendered conditionally rather than self-suppressing: the section
              owns the image-input hook, and leaving the image step has to UNMOUNT
              it so a refusal cannot come back over an empty zone and the paste
              listener cannot outlive the step. See usePersonaImageInput. */}
          {importType === 'image' && (
            <FileUploadSection importFileName={importFileName} onFileChange={onFileChange} />
          )}
          <TextInputSection importType={importType} importContent={importContent} onContentChange={onContentChange} />

          {/* Info */}
          <div className="bg-purple-50 rounded-lg p-4 text-sm">
            <p className="text-purple-700">
              <strong>{t('importPersona.aiPoweredImport')}</strong> {t('importPersona.aiImportDesc', { type: t(`importPersona.importType${importType.charAt(0).toUpperCase() + importType.slice(1)}`) })}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">{t('importPersona.cancel')}</button>
          <button
            onClick={onImport}
            // Same predicate as the server's empty-content guard, so a
            // whitespace-only paste is a disabled button rather than a 400 the
            // user has to read to discover there was nothing to send.
            disabled={importContent.trim() === '' || isImporting}
            className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
          >
            {isImporting ? (
              <><Loader2 size={16} className="animate-spin" />{t('importPersona.importing')}</>
            ) : (
              <><Upload size={16} />{t('importPersona.importButton')}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
