/**
 * @fileoverview The step palette (7.52.00 C2; docs/ux part 5 §5.5): grouped by kind (an engineering flow's: Start and
 * end, Agents from the Registry, Quality gates, Flows, Platform steps; an agents workflow keeps its groups), each row
 * a 20 × 14 mini shape of its kind and its glyph, so the palette teaches the canvas's language, with a visible hint
 * per group (never a native title) and a search. Each row drags onto the canvas as a block (`BLOCK_MIME`, JSON
 * `{type, params, title}`; `PALETTE_MIME` too for a plain step, for a release) with the node it makes as its drag
 * image (`NodePreview`), and is a button: a click adds the step below the graph, Enter adds it after the selected
 * step and connects it (paletteItems.ts, model.ts `addBlockAfter`). An item that cannot be added says why as text.
 *
 * @module components/WorkflowEditor/NodePalette
 */
import { useId, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { BLOCK_MIME, PALETTE_MIME } from './model'
import { filterSections, paletteSections, setDragTitle } from './paletteItems'
import { NodePreview } from './nodes/NodePreview'
import { kindOf, tileTone, TILE_CLASS } from './nodes/nodeKinds'
import { glyphNameOf } from './nodes/nodeGlyphs'
import { GlyphIcon } from './nodes/GlyphIcon'
import { usedByOf } from '../../api/workflowsApi'
import type { DragEvent, KeyboardEvent } from 'react'
import type { WorkflowNode, WorkflowSchema } from '../../api/workflowsApi'
import type { PaletteBlock } from './model'
import type { NodeKind } from './nodes/nodeKinds'
import type { PaletteItem, PaletteSources } from './paletteItems'

interface NodePaletteProps {
  /** Add a block: below the graph (`after` false: a click), or after the selected step, connected (Enter). */
  onAdd: (block: PaletteBlock, after: boolean) => void
  disabled?: boolean
  /** The workflow's kind: an agents workflow's sections, or an engineering flow's. */
  schema: WorkflowSchema
  /** What an engineering flow's palette is built from (the Registry, the gates, the library), each where it was read. */
  sources?: PaletteSources
}

const NO_SOURCES: PaletteSources = {
  cards: undefined, gates: undefined, flows: undefined, workflowId: '', usedBy: usedByOf(undefined),
}

const MINI_SHAPES: Readonly<Record<NodeKind, string>> = {
  trigger: 'voc-mini-shape-pill', end: 'voc-mini-shape-pill', decision: 'voc-mini-shape-diamond', agent: 'voc-mini-shape-card',
  team: 'voc-mini-shape-card', gate: 'voc-mini-shape-hexagon', call: 'voc-mini-shape-stack', platform: 'voc-mini-shape-square',
}

/** The block as the step it makes (for its kind, glyph and drag preview). */
const stepOf = (block: PaletteBlock): WorkflowNode => ({
  id: 'preview', type: block.type, position: { x: 0, y: 0 }, data: { title: block.title, params: { ...block.params } },
})

function PaletteRow({ item, disabled, onAdd, onPreview, onDragStart }: Readonly<{
  item: PaletteItem; disabled: boolean; onAdd: NodePaletteProps['onAdd']; onPreview: (item: PaletteItem) => void
  onDragStart: (event: DragEvent, item: PaletteItem) => void
}>) {
  const step = stepOf(item.block)
  const kind = kindOf(step)
  const off = disabled || item.disabledReason !== null
  const reasonId = useId()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || off) return
    event.preventDefault()
    onAdd(item.block, true)
  }
  return (
    <li>
      <button type="button" draggable={!off} disabled={off} aria-describedby={item.disabledReason === null ? undefined : reasonId}
        onDragStart={(event) => onDragStart(event, item)} onPointerEnter={() => onPreview(item)} onFocus={() => onPreview(item)}
        onClick={() => onAdd(item.block, false)} onKeyDown={onKeyDown}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:border-border-strong hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40 cursor-grab">
        <span className={clsx('voc-mini-shape', MINI_SHAPES[kind])} aria-hidden="true" />
        <span className={clsx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm', TILE_CLASS[tileTone(kind)])} aria-hidden="true">
          <GlyphIcon name={glyphNameOf(step)} size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.meta !== '' && <span className="shrink-0 text-[12px] text-muted" aria-hidden="true">{item.meta}</span>}
      </button>
      {item.disabledReason !== null && <p id={reasonId} className="mt-0.5 text-[12px] text-muted">{item.disabledReason}</p>}
    </li>
  )
}

export function NodePalette({ onAdd, disabled = false, schema, sources = NO_SOURCES }: Readonly<NodePaletteProps>) {
  const { t } = useTranslation('agents')
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<PaletteItem | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const sections = useMemo(() => paletteSections(t, schema, sources), [t, schema, sources])
  const shown = filterSections(sections, query)
  const onDragStart = (event: DragEvent, item: PaletteItem) => {
    event.dataTransfer.setData(BLOCK_MIME, JSON.stringify(item.block))
    // (a plain step keeps the bare type of before 7.52.00, for a canvas that reads only it)
    if (item.key.startsWith('type:')) event.dataTransfer.setData(PALETTE_MIME, item.block.type)
    event.dataTransfer.effectAllowed = 'copy'
    setDragTitle(item.label)
    if (previewRef.current !== null && preview?.key === item.key) event.dataTransfer.setDragImage(previewRef.current, 24, 16)
  }
  return (
    <nav aria-label={t('editor.palette')} className="space-y-3" onDragEnd={() => setDragTitle('')}>
      <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t('editor.palette')}</p>
      <p className="text-[12px] text-muted">{t('editor.paletteHint')}</p>
      <label className="relative block">
        <span className="sr-only">{t('palette.search')}</span>
        <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input type="search" className="input w-full pl-7" value={query} placeholder={t('palette.search')}
          onChange={(e) => setQuery(e.target.value)} />
      </label>
      {shown.length === 0 && <p className="text-[12px] text-muted">{t('palette.noMatch')}</p>}
      {shown.map((section) => (
        <div key={section.id} role="group" aria-label={section.heading}>
          <p className="mb-1 text-[12px] font-medium text-muted">{section.heading}</p>
          {section.hint !== '' && <p className="mb-1 text-[12px] text-muted">{section.hint}</p>}
          <ul className="space-y-1">
            {section.items.map((item) => (
              <PaletteRow key={item.key} item={item} disabled={disabled} onAdd={onAdd} onPreview={setPreview} onDragStart={onDragStart} />
            ))}
          </ul>
        </div>
      ))}
      {preview !== null && <NodePreview ref={previewRef} step={stepOf(preview.block)} />}
    </nav>
  )
}
