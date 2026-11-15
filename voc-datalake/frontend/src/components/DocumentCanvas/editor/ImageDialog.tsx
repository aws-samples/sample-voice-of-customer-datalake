/** The "/" menu's Image: an address and the alt text (required: it is what people who cannot see the image get). */
import type { Editor } from '@tiptap/core'
import { type SyntheticEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isSafeHref } from '../markdown/links'
import CanvasPopover from './CanvasPopover'
import type { Anchor } from './floating'
import PopoverField from './PopoverField'

interface ImageDialogProps {
  readonly editor: Editor
  readonly anchor: Anchor
  readonly onClose: () => void
}

const isImageAddress = (url: string) => url !== '' && isSafeHref(url) && !/^mailto:/i.test(url)

export default function ImageDialog({ editor, anchor, onClose }: ImageDialogProps) {
  const { t } = useTranslation('projectDetail')
  const [src, setSrc] = useState('')
  const [alt, setAlt] = useState('')
  const [errors, setErrors] = useState<{ src: string | null; alt: string | null }>({ src: null, alt: null })

  const close = () => {
    onClose()
    editor.commands.focus()
  }

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = src.trim()
    const next = {
      src: isImageAddress(url) ? null : t('canvas.editor.image.invalidUrl'),
      alt: alt.trim() === '' ? t('canvas.editor.image.altRequired') : null,
    }
    setErrors(next)
    if (next.src || next.alt) return
    editor.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'image', attrs: { src: url, alt: alt.trim() } }] }).run()
    onClose()
  }

  return (
    <CanvasPopover title={t('canvas.editor.image.title')} anchor={anchor} onClose={close}>
      <form onSubmit={submit} noValidate>
        <PopoverField type="url" label={t('canvas.editor.image.url')} value={src} error={errors.src} onChange={setSrc} placeholder="https://" />
        <PopoverField label={t('canvas.editor.image.alt')} hint={t('canvas.editor.image.altHint')} value={alt} error={errors.alt} onChange={setAlt} />
        <div className="canvas-popover__actions">
          <button type="button" className="canvas-button canvas-button--quiet" onClick={close}>{t('canvas.editor.image.cancel')}</button>
          <button type="submit" className="canvas-button canvas-button--primary">{t('canvas.editor.image.insert')}</button>
        </div>
      </form>
    </CanvasPopover>
  )
}
