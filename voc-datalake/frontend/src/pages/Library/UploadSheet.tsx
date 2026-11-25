/**
 * @fileoverview The upload sheet: choose (or drop) one or more files, look over each one's details, then upload them
 * one after another with each file's progress and outcome (useLibraryUpload.ts). While a file is in flight the sheet
 * stays open: closing it would not stop the upload.
 *
 * @module pages/Library/UploadSheet
 */
import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { FilePlus2, Upload } from 'lucide-react'
import SideSheet from '../../components/SideSheet/SideSheet'
import { dragCarriesFiles, toArray } from '../../utils/imageInput'
import { ACCEPT_ATTR } from './libraryFormats'
import UploadEntryCard from './UploadEntryCard'
import { useLibraryUpload } from './useLibraryUpload'

function DropZone({ disabled, onFiles }: Readonly<{ disabled: boolean; onFiles: (files: readonly File[]) => void }>) {
  const { t } = useTranslation('library')
  const input = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(false)
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setActive(false)
    if (!disabled) onFiles(toArray(event.dataTransfer.files))
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragCarriesFiles(event) || disabled) return
    event.preventDefault()
    setActive(true)
  }
  return (
    <div onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setActive(false)}
      className={clsx('flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-4 text-center',
        active ? 'border-accent bg-accent-subtle' : 'border-border')}>
      <FilePlus2 size={20} className="text-muted" aria-hidden="true" />
      <p className="text-sm text-muted">{t('upload.dropHint')}</p>
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => input.current?.click()}>
        {t('upload.choose')}
      </button>
      <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="sr-only" tabIndex={-1} aria-hidden="true"
        data-testid="library-file-input"
        onChange={(event) => {
          onFiles(toArray(event.target.files))
          event.target.value = ''
        }} />
      <p className="text-[12px] text-muted">{t('upload.limits')}</p>
    </div>
  )
}

export default function UploadSheet({ isOpen, onClose }: Readonly<{ isOpen: boolean; onClose: () => void }>) {
  const { t } = useTranslation('library')
  const upload = useLibraryUpload()
  const close = () => {
    if (upload.running) return
    upload.reset()
    onClose()
  }
  const finished = upload.entries.length > 0 && upload.entries.every((entry) => entry.phase === 'done')
  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={close} disabled={upload.running}>
        {finished ? t('upload.done') : t('upload.cancel')}
      </button>
      {finished ? null : (
        <button type="button" className="btn btn-primary" disabled={upload.running || upload.sendable === 0}
          onClick={() => void upload.start()}>
          <Upload size={16} aria-hidden="true" />
          {t('upload.start', { count: upload.sendable })}
        </button>
      )}
    </>
  )
  return (
    <SideSheet isOpen={isOpen} onClose={close} title={t('upload.title')} description={t('upload.description')} icon={Upload}
      footer={footer} dismissable={!upload.running}>
      <DropZone disabled={upload.running} onFiles={upload.add} />
      {upload.entries.length === 0 ? null : (
        <ul className="space-y-3" aria-label={t('upload.filesLabel')}>
          {upload.entries.map((entry) => (
            <UploadEntryCard key={entry.key} entry={entry} running={upload.running}
              onChange={(fields) => upload.setFields(entry.key, fields)} onRemove={() => upload.remove(entry.key)} />
          ))}
        </ul>
      )}
    </SideSheet>
  )
}
