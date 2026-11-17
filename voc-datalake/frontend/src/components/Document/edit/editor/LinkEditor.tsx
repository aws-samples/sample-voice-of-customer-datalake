/** The link editor (Mod+K or the format bar): http(s), mailto and app paths only; javascript: and data: are refused. */
import type { Editor } from '@tiptap/core'
import { type SyntheticEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeHref } from '../markdown/links'
import CanvasPopover from './CanvasPopover'
import type { Anchor } from './floating'
import PopoverField from './PopoverField'

interface LinkEditorProps {
  readonly editor: Editor
  readonly anchor: Anchor
  readonly onClose: () => void
}

function currentHref(editor: Editor): string {
  const href: unknown = editor.getAttributes('link').href
  return typeof href === 'string' ? href : ''
}

export default function LinkEditor({ editor, anchor, onClose }: LinkEditorProps) {
  const { t } = useTranslation('documents')
  const existing = currentHref(editor)
  const [value, setValue] = useState(existing)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    onClose()
    editor.commands.focus()
  }

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const href = normalizeHref(value)
    if (!href) {
      setError(t('editor.link.invalid'))
      return
    }
    const chain = editor.chain().focus().extendMarkRange('link')
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: value.trim(), marks: [{ type: 'link', attrs: { href } }] }).run()
    } else {
      chain.setLink({ href }).run()
    }
    onClose()
  }

  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    onClose()
  }

  return (
    <CanvasPopover title={t('editor.link.title')} anchor={anchor} onClose={close}>
      <form onSubmit={submit} noValidate>
        <PopoverField
          label={t('editor.link.url')}
          placeholder={t('editor.link.placeholder')}
          value={value}
          error={error}
          onChange={(next) => {
            setValue(next)
            setError(null)
          }}
        />
        <div className="canvas-popover__actions">
          {existing !== '' && (
            <button type="button" className="canvas-button canvas-button--quiet" onClick={remove}>{t('editor.link.remove')}</button>
          )}
          <button type="button" className="canvas-button canvas-button--quiet" onClick={close}>{t('editor.link.cancel')}</button>
          <button type="submit" className="canvas-button canvas-button--primary">{t('editor.link.apply')}</button>
        </div>
      </form>
    </CanvasPopover>
  )
}
