/**
 * @fileoverview The step palette: every node type, grouped, draggable onto the
 * canvas (HTML5 drag with {@link PALETTE_MIME}). Each entry is also a button
 * that adds the step below the current graph, so the palette works without a
 * pointer (keyboard / assistive tech).
 *
 * @module components/WorkflowEditor/NodePalette
 */
import { useTranslation } from 'react-i18next'
import { NodeTypeIcon } from './NodeTypeIcon'
import { NODE_CATALOGUE, PALETTE_GROUPS, PALETTE_MIME } from './model'
import { WORKFLOW_NODE_TYPES } from '../../api/workflowsApi'
import type { DragEvent } from 'react'
import type { WorkflowNodeType } from '../../api/workflowsApi'

interface NodePaletteProps {
  onAdd: (type: WorkflowNodeType) => void
  disabled?: boolean
}

export function NodePalette({ onAdd, disabled = false }: Readonly<NodePaletteProps>) {
  const { t } = useTranslation('agents')
  const onDragStart = (event: DragEvent, type: WorkflowNodeType) => {
    event.dataTransfer.setData(PALETTE_MIME, type)
    event.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <nav aria-label={t('editor.palette')} className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t('editor.palette')}</p>
      <p className="text-[12px] text-muted">{t('editor.paletteHint')}</p>
      {PALETTE_GROUPS.map((group) => {
        const types = WORKFLOW_NODE_TYPES.filter((type) => NODE_CATALOGUE[type].group === group)
        return (
          <div key={group}>
            <p className="mb-1 text-[12px] font-medium text-muted">{t(`paletteGroups.${group}`)}</p>
            <ul className="space-y-1">
              {types.map((type) => (
                <li key={type}>
                  <button
                    type="button"
                    draggable={!disabled}
                    disabled={disabled}
                    onDragStart={(event) => onDragStart(event, type)}
                    onClick={() => onAdd(type)}
                    title={t(`nodeTypes.${type}.description`)}
                    className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-left text-[13px] text-text hover:bg-bg-hover hover:border-border-strong transition-colors cursor-grab disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <NodeTypeIcon type={type} className="text-muted" />
                    <span className="truncate">{t(`nodeTypes.${type}.label`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
