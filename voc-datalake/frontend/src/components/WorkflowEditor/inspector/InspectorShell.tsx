/**
 * @fileoverview The inspector's shell (7.52.00 C2; docs/ux part 5 §5.4): the kind's tile and the title (an `h2` that
 * takes focus when the inspector opens from the keyboard), the kind line ("Agent · Fixer"), a run's state chip and
 * "Close inspector"; the mode line (view: "Read only." with Edit in Flows for an administrator; run: "As this run
 * used it · r4"); the kind's tabs; and its sections. Escape closes it (an open select or menu takes Escape first).
 *
 * The two sections keep editable and read only apart (N15): **In this flow** (a step's own fields: edited while
 * building, plain text otherwise) and **From the card** (always read only: `FromCard.tsx`).
 *
 * @module components/WorkflowEditor/inspector/InspectorShell
 */
import { useEffect, useRef } from 'react'
import { Info, Pencil, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../IconTabs/IconTabs'
import { Tooltip } from '../../Tooltip/Tooltip'
import type { KeyboardEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { FlowMode } from '../nodes/nodeData'

interface InspectorTabs<T extends string> {
  readonly ids: readonly T[]
  readonly active: T
  readonly icons: Readonly<Record<T, LucideIcon>>
  readonly labelOf: (id: T) => ReactNode
  readonly onSelect: (id: T) => void
}

interface ShellProps<T extends string> {
  readonly tile: ReactNode
  readonly title: string
  /** "Agent · Fixer", "Gate · 3 rounds at most". */
  readonly kindLine: string
  readonly mode: FlowMode
  /** A run's state chip beside the title. */
  readonly state?: ReactNode
  /** View: where an administrator edits this flow ("Edit in Flows"); null: not offered. */
  readonly editPath?: string | null
  /** Run: the revision of the run's copy. */
  readonly runRevision?: number | null
  readonly tabs?: InspectorTabs<T>
  /** Move focus to the heading when the inspector opens (it opened from the keyboard). */
  readonly focusHeading?: boolean
  readonly onClose?: () => void
  readonly children: ReactNode
}

/** The mode line: read only and where to edit (view), or the run's copy (run); none while building. */
function ModeLine({ mode, editPath, runRevision }: Readonly<{ mode: FlowMode; editPath?: string | null; runRevision?: number | null }>) {
  const { t } = useTranslation('agents')
  if (mode === 'view') {
    return (
      <p role="note" className="flex flex-wrap items-center gap-2 rounded-md bg-bg-accent px-2 py-1.5 text-[12px] text-text">
        <Info size={13} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="mr-auto">{t('inspector.readOnly')}</span>
        {editPath !== undefined && editPath !== null && (
          <Link to={editPath} className="btn btn-ghost btn-sm"><Pencil size={13} aria-hidden="true" /> {t('inspector.editInFlows')}</Link>
        )}
      </p>
    )
  }
  if (mode === 'run') {
    return (
      <p className="text-[12px] text-muted">
        {runRevision === undefined || runRevision === null ? t('inspector.asRunUsed') : t('inspector.asRun', { n: runRevision })}
      </p>
    )
  }
  return null
}

export function InspectorShell<T extends string>({
  tile, title, kindLine, mode, state, editPath, runRevision, tabs, focusHeading = false, onClose, children,
}: ShellProps<T>) {
  const { t } = useTranslation('agents')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusHeading) heading.current?.focus()
  }, [focusHeading, title])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || onClose === undefined) return
    event.stopPropagation()
    onClose()
  }
  return (
    <div className="space-y-3" onKeyDown={onKeyDown} data-testid="flow-inspector">
      <header className="flex items-start gap-2">
        {tile}
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="focus-ring break-words rounded-sm text-sm font-semibold text-text-strong">
            {title}
          </h2>
          <p className="text-[12px] text-text">{kindLine}</p>
          {state}
        </div>
        {onClose !== undefined && (
          <Tooltip kind="label" content={t('inspector.close')}>
            <button type="button" className="icon-btn" aria-label={t('inspector.close')} onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </header>
      <ModeLine mode={mode} editPath={editPath} runRevision={runRevision} />
      {tabs !== undefined && tabs.ids.length > 1 && (
        <IconTabs tabs={tabs.ids} active={tabs.active} icons={tabs.icons} label={t('inspector.tabs')}
          labelOf={tabs.labelOf} onSelect={tabs.onSelect} />
      )}
      <div role={tabs !== undefined && tabs.ids.length > 1 ? 'tabpanel' : undefined} className="space-y-4">{children}</div>
    </div>
  )
}

/** A section's heading: "In this flow", "From the card fixer v4", "Pack python". */
export function SectionHeading({ children, action }: Readonly<{ children: ReactNode; action?: ReactNode }>) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="mr-auto text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{children}</h3>
      {action}
    </div>
  )
}

/** Read-only facts as a definition list in body text (never disabled inputs, N15). */
export function Facts({ rows }: Readonly<{ rows: ReadonlyArray<readonly [string, ReactNode] | null> }>) {
  const shown = rows.filter((row): row is readonly [string, ReactNode] => row !== null)
  if (shown.length === 0) return null
  return (
    <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      {shown.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd className="min-w-0 break-words text-text">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Three skeleton rows: a section whose read is on its way (the flow's own fields draw at once). */
export function SectionLoading() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="skeleton h-4 w-3/4" /><div className="skeleton h-4" /><div className="skeleton h-4 w-5/6" />
    </div>
  )
}
