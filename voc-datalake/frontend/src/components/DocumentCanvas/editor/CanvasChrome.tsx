/**
 * Everything around the canvas's text: the block handle, the format bar, the "/" menu and the popovers. CanvasEditor
 * loads it as a chunk of its own (with the menus' libraries: vendorChunks.json `vendor-editor-menus`), so the
 * document's text shows without waiting for it.
 */
import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useState } from 'react'
import BlockHandle from './BlockHandle'
import BlockMenu from './BlockMenu'
import type { CanvasController } from './controller'
import { type Anchor, anchorAt } from './floating'
import FormatBar from './FormatBar'
import ImageDialog from './ImageDialog'
import LinkEditor from './LinkEditor'
import SlashMenu from './SlashMenu'

type Popover = { readonly kind: 'link' | 'image'; readonly anchor: Anchor } | { readonly kind: 'block'; readonly pos: number; readonly anchor: Anchor }

interface CanvasChromeProps {
  readonly editor: Editor
  readonly editable: boolean
  readonly container: HTMLElement | null
  readonly controller: CanvasController
  readonly onComment?: () => void
}

export default function CanvasChrome({ editor, editable, container, controller, onComment }: CanvasChromeProps) {
  const [popover, setPopover] = useState<Popover | null>(null)
  const closePopover = useCallback(() => setPopover(null), [])
  const lastPointer = useCallback(() => controller.lastPointer(), [controller])
  const openAt = useCallback((kind: 'link' | 'image', pos: number) => setPopover({ kind, anchor: anchorAt(editor, pos, container) }), [editor, container])

  useEffect(() => {
    controller.setOpenLink(() => openAt('link', editor.state.selection.to))
    controller.setOpenBlockMenu((pos) => setPopover({ kind: 'block', pos, anchor: anchorAt(editor, pos + 1, container) }))
    return () => {
      controller.setOpenLink(null)
      controller.setOpenBlockMenu(null)
    }
  }, [editor, container, controller, openAt])

  return (
    <>
      {editable && <BlockHandle editor={editor} onOpenMenu={(pos) => controller.openBlockMenu(pos)} lastPointer={lastPointer} />}
      <FormatBar editor={editor} controller={controller} onComment={onComment} />
      {editable && <SlashMenu editor={editor} container={container} controller={controller} onImage={() => openAt('image', editor.state.selection.from)} />}
      {popover?.kind === 'link' && <LinkEditor editor={editor} anchor={popover.anchor} onClose={closePopover} />}
      {popover?.kind === 'image' && <ImageDialog editor={editor} anchor={popover.anchor} onClose={closePopover} />}
      {popover?.kind === 'block' && <BlockMenu editor={editor} pos={popover.pos} anchor={popover.anchor} onClose={closePopover} />}
    </>
  )
}
