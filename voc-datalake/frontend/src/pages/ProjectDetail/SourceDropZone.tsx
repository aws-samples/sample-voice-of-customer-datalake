/**
 * @fileoverview The Sources card's drop zone (7.104.00, moved from the docs card it replaces): drag and drop, click
 * or keyboard to pick, and paste a screenshot onto the card.
 *
 * `role="button"` on a div, with the file input as a hidden SIBLING, so there is exactly one way to open the picker
 * per modality: a `<label>` around a file input has its own activation (some browsers synthesise a click on the
 * control), and a nested input's `click()` would bubble back into the zone's onClick. Enter activates on keydown and
 * Space on keyup (the ARIA APG button pattern: a held Space repeats keydown), and only a Space this element saw go
 * down may activate it. `preventDefault` on dragenter/dragover is what makes this a drop target, so it runs for a
 * FILE drag only; a dragleave from the zone's own children does not unmark it.
 *
 * @module pages/ProjectDetail/SourceDropZone
 */
import { useCallback, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { dragCarriesFiles, dragLeavesElement, toArray } from '../../utils/imageInput'
import { SOURCE_ACCEPT_ATTR } from './productSourceUpload'
import type { DragEvent, KeyboardEvent } from 'react'

function useDropTarget(onFiles: (files: readonly File[]) => void) {
  const [active, setActive] = useState(false)
  const enter = (event: DragEvent) => {
    if (!dragCarriesFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    setActive(true)
  }
  return {
    active,
    onDragEnter: enter,
    onDragOver: enter,
    onDragLeave: (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (dragLeavesElement(event)) setActive(false)
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setActive(false)
      onFiles(toArray(event.dataTransfer.files))
    },
  }
}

/** Enter on keydown, Space armed on keydown and spent on keyup, disarmed on blur. */
function useButtonKeys(activate: () => void) {
  // A ref, not state: the keyup reads what the keydown of the same gesture wrote, and it must not re-render.
  const spaceArmed = useRef(false)
  return {
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        activate()
        return
      }
      if (event.key !== ' ') return
      event.preventDefault()
      spaceArmed.current = true
    },
    onKeyUp: (event: KeyboardEvent) => {
      if (event.key !== ' ' || !spaceArmed.current) return
      spaceArmed.current = false
      event.preventDefault()
      activate()
    },
    onBlur: () => { spaceArmed.current = false },
  }
}

export default function SourceDropZone({ onFiles }: Readonly<{ onFiles: (files: readonly File[]) => void }>) {
  const { t } = useTranslation('projectDetail')
  const input = useRef<HTMLInputElement>(null)
  const openPicker = useCallback(() => { input.current?.click() }, [])
  const { active, ...drop } = useDropTarget(onFiles)
  const keys = useButtonKeys(openPicker)
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t('product.sources.dropZone')}
        // A stable hook for the drag-state test, so a restyle cannot fail as if the drag handlers broke.
        data-drag-active={active}
        className={`block cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          active ? 'border-accent bg-accent-subtle' : 'border-border-strong hover:border-accent/60 hover:bg-accent-subtle'
        }`}
        onClick={openPicker}
        {...keys}
        {...drop}
      >
        <div className="text-sm text-text">
          <Upload size={20} className="mx-auto mb-1 text-muted" aria-hidden="true" />
          {t('product.sources.dropZone')}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={SOURCE_ACCEPT_ATTR}
        onChange={(event) => {
          // Copied before the reset: a cleared input empties its live FileList.
          onFiles(toArray(event.target.files))
          event.target.value = ''
        }}
        className="hidden"
      />
      <p className="text-xs text-muted">{t('product.sources.accepted')}</p>
    </>
  )
}
