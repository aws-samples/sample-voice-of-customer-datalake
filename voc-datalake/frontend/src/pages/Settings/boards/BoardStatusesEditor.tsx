/**
 * @fileoverview The board editor's statuses: rename, move up / down, remove, add (at most 8). The
 * first status is the one every new request starts in. A status's key never changes once it
 * exists (requests store it); a new status gets a key from its label.
 * @module pages/Settings/boards/BoardStatusesEditor
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { BOARD_LIMITS } from '../../../api/boardFields'
import type { BoardStatus } from '../../../api/boardFields'
import { moveStatus, statusKeyFor } from './boardDraft'

type Statuses = readonly BoardStatus[]

function StatusRow({ status, index, count, disabled, onLabel, onMove, onRemove }: Readonly<{
  status: BoardStatus; index: number; count: number; disabled: boolean
  onLabel: (label: string) => void; onMove: (step: -1 | 1) => void; onRemove: () => void
}>) {
  const { t } = useTranslation('settings')
  const name = status.label.trim() === '' ? status.key : status.label
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <input className="input min-w-[10rem] flex-1" value={status.label} maxLength={BOARD_LIMITS.statusLabel} disabled={disabled}
        aria-label={t('boards.statuses.labelFor', { position: index + 1 })} aria-invalid={status.label.trim() === ''}
        onChange={(e) => onLabel(e.target.value)} />
      <span className="font-mono text-xs text-muted">{status.key}</span>
      {index === 0 ? <span className="badge badge-accent">{t('boards.statuses.initial')}</span> : null}
      <div className="flex items-center gap-1">
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || index === 0} onClick={() => onMove(-1)}
          aria-label={t('boards.statuses.moveUp', { status: name })}><ArrowUp size={14} aria-hidden="true" /></button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || index === count - 1} onClick={() => onMove(1)}
          aria-label={t('boards.statuses.moveDown', { status: name })}><ArrowDown size={14} aria-hidden="true" /></button>
        <button type="button" className="btn btn-ghost btn-sm hover:text-danger" disabled={disabled || count === 1} onClick={onRemove}
          aria-label={t('boards.statuses.remove', { status: name })}><Trash2 size={14} aria-hidden="true" /></button>
      </div>
    </li>
  )
}

function AddStatus({ statuses, disabled, onAdd }: Readonly<{ statuses: Statuses; disabled: boolean; onAdd: (status: BoardStatus) => void }>) {
  const { t } = useTranslation('settings')
  const id = useId()
  const [label, setLabel] = useState('')
  const full = statuses.length >= BOARD_LIMITS.statuses
  const add = () => {
    if (label.trim() === '' || full) return
    onAdd({ key: statusKeyFor(label, statuses.map((status) => status.key)), label: label.trim() })
    setLabel('')
  }
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-text">{t('boards.statuses.newLabel')}</label>
      <div className="flex flex-wrap gap-2">
        <input id={id} className="input min-w-[10rem] flex-1" value={label} maxLength={BOARD_LIMITS.statusLabel} disabled={disabled || full}
          onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || full || label.trim() === ''} onClick={add}>
          <Plus size={14} aria-hidden="true" /> {t('boards.statuses.add')}
        </button>
      </div>
      {full ? <p className="text-xs text-muted">{t('boards.statuses.full', { max: BOARD_LIMITS.statuses })}</p> : null}
    </div>
  )
}

export default function BoardStatusesEditor({ statuses, disabled, onChange }: Readonly<{
  statuses: Statuses; disabled: boolean; onChange: (statuses: BoardStatus[]) => void
}>) {
  const { t } = useTranslation('settings')
  const relabel = (index: number, label: string) =>
    onChange(statuses.map((status, i) => (i === index ? { ...status, label } : status)))
  return (
    <section className="space-y-2" aria-labelledby="board-statuses-title">
      <h3 id="board-statuses-title" className="text-sm font-semibold tracking-tight text-text-strong">{t('boards.statuses.title')}</h3>
      <p className="text-xs text-muted">{t('boards.statuses.hint', { max: BOARD_LIMITS.statuses })}</p>
      <ol className="divide-y divide-border">
        {statuses.map((status, index) => (
          <StatusRow key={status.key} status={status} index={index} count={statuses.length} disabled={disabled}
            onLabel={(label) => relabel(index, label)} onMove={(step) => onChange(moveStatus(statuses, index, step))}
            onRemove={() => onChange(statuses.filter((_, i) => i !== index))} />
        ))}
      </ol>
      <AddStatus statuses={statuses} disabled={disabled} onAdd={(status) => onChange([...statuses, status])} />
    </section>
  )
}
