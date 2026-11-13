/**
 * @fileoverview Everything testers said about a prototype series, in one view
 * (docs/prototype-builder.md Part 3): the feedback route's groups by screen, its
 * folded items, the notes when the read was partial, and a selection of at most
 * {@link MAX_SELECTED_PINS} pins. Project editors only (the route is EDIT). Nothing
 * is selected by default; "Incorporate" renders only for a caller that handles it.
 * It fills a dialog (PrototypeFeedbackDialog): the list is the dialog's one scrolling
 * body, the selection its footer, so the count and the actions stay on screen.
 * @module components/PrototypeFeedback/PrototypeFeedbackView
 */
import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Info, Loader2, MessageSquareText, Wand2 } from 'lucide-react'
import { prototypeFeedbackQueryKey } from '../../api/prototypePinsApi'
import { getPrototypeFeedback, type FeedbackGroup, type FeedbackItem as Item, type PrototypeFeedback } from '../../api/prototypeFeedbackSchema'
import FeedbackItemCard from './FeedbackItemCard'
import {
  MAX_SELECTED_PINS, blockedReason, clearGroup, groupFullySelected, selectGroup, selectedPinCount, selectedPinIds,
} from './selection'

interface PrototypeFeedbackViewProps {
  readonly projectId: string
  readonly documentId: string
  /** Starts an incorporation of the selected pins. Without it there is no Incorporate button. */
  readonly onIncorporate?: (pinIds: string[]) => void
}

function ReadNotes({ feedback }: { readonly feedback: PrototypeFeedback }) {
  const { t } = useTranslation('components')
  const notes = [
    ...feedback.cut.map((cut) => ({ key: `cut-${cut.document_id}`, text: t('prototypeFeedback.cut', { version: cut.version }) })),
    ...(feedback.older_versions_unread > 0
      ? [{ key: 'older', text: t('prototypeFeedback.olderUnread', { count: feedback.older_versions_unread }) }]
      : []),
  ]
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted inline-flex items-start gap-1.5">
        <Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
        <span>{t('prototypeFeedback.anonymous')}</span>
      </p>
      {notes.length > 0 ? (
        <ul className="space-y-1" data-testid="feedback-partial">
          {notes.map((note) => (
            <li key={note.key} className="text-xs text-warn inline-flex items-start gap-1.5 w-full">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
              <span>{note.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

interface GroupSectionProps {
  readonly group: FeedbackGroup
  readonly allItems: readonly Item[]
  readonly selected: ReadonlySet<string>
  readonly pinTotal: number
  readonly onChange: (next: Set<string>) => void
}

function GroupSection({ group, allItems, selected, pinTotal, onChange }: GroupSectionProps) {
  const { t } = useTranslation('components')
  const headingId = useId()
  const screen = group.route || t('prototypeFeedback.noScreen')
  const full = groupFullySelected(group, selected)
  const anySelectable = group.items.some((item) => !item.flagged && item.count <= MAX_SELECTED_PINS)
  // At the cap, "Select all" would add nothing: it says so by being off rather than doing nothing.
  const canAdd = group.items.some((item) => blockedReason(item, selected, pinTotal) === null && !selected.has(item.item_id))
  const toggleItem = (item: Item, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(item.item_id)
    else next.delete(item.item_id)
    onChange(next)
  }
  return (
    <section aria-labelledby={headingId} className="space-y-2 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold tracking-tight text-text-strong break-words min-w-0">
          {t('prototypeFeedback.screenHeading', { screen })}
          <span className="ml-2 badge badge-muted font-mono">{group.items.length}</span>
        </h3>
        {anySelectable ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-describedby={headingId}
            disabled={!full && !canAdd}
            onClick={() => onChange(full ? clearGroup(group, selected) : selectGroup(group, allItems, selected))}
          >
            {full ? t('prototypeFeedback.clearGroup') : t('prototypeFeedback.selectGroup')}
          </button>
        ) : null}
      </div>
      <ul className="space-y-2">
        {group.items.map((item) => (
          <FeedbackItemCard
            key={item.item_id}
            item={item}
            checked={selected.has(item.item_id)}
            blocked={blockedReason(item, selected, pinTotal)}
            onToggle={(checked) => toggleItem(item, checked)}
          />
        ))}
      </ul>
    </section>
  )
}

function SelectionBar({
  items, selected, onClear, onIncorporate,
}: {
  readonly items: readonly Item[]
  readonly selected: ReadonlySet<string>
  readonly onClear: () => void
  readonly onIncorporate?: (pinIds: string[]) => void
}) {
  const { t } = useTranslation('components')
  const capId = useId()
  const pins = selectedPinCount(items, selected)
  const count = items.filter((item) => selected.has(item.item_id)).length
  // A refetch can fold new pins into an item already selected, so the selection can pass the cap after the fact.
  const overCap = pins > MAX_SELECTED_PINS
  return (
    <div className="dialog-footer flex-wrap justify-between">
      <p className="text-sm text-text" aria-live="polite" data-testid="feedback-selection-count">
        {t('prototypeFeedback.selectedCount', { count, pins: t('prototypeFeedback.pinCount', { count: pins }) })}
        <span className="text-muted"> · </span>
        <span id={capId} className={overCap ? 'text-warn font-medium' : 'text-muted'} data-testid="feedback-cap-note">
          {t('prototypeFeedback.cap', { max: MAX_SELECTED_PINS })}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClear} disabled={count === 0}>
          {t('prototypeFeedback.clearSelection')}
        </button>
        {onIncorporate ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={count === 0 || overCap}
            aria-describedby={overCap ? capId : undefined}
            onClick={() => onIncorporate(selectedPinIds(items, selected))}>
            <Wand2 size={14} aria-hidden /> {t('prototypeFeedback.incorporate')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default function PrototypeFeedbackView({ projectId, documentId, onIncorporate }: PrototypeFeedbackViewProps) {
  const { t } = useTranslation('components')
  const query = useQuery({
    queryKey: prototypeFeedbackQueryKey(projectId, documentId),
    queryFn: () => getPrototypeFeedback(projectId, documentId),
  })
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => query.data?.groups ?? [], [query.data])
  const allItems = useMemo(() => groups.flatMap((group) => group.items), [groups])
  // An item that left the answer (resolved elsewhere, refetched) is no longer selected.
  const live = useMemo(() => new Set(allItems.filter((item) => selected.has(item.item_id)).map((item) => item.item_id)), [allItems, selected])
  const pinTotal = selectedPinCount(allItems, live)

  if (query.isPending) {
    return (
      <div className="dialog-body">
        <p className="text-sm text-muted inline-flex items-center gap-2" role="status">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> {t('prototypeFeedback.loading')}
        </p>
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="dialog-body">
        <div role="alert" className="text-sm text-danger space-y-2">
          <p className="inline-flex items-center gap-1.5"><AlertCircle size={14} aria-hidden /> {t('prototypeFeedback.loadFailed')}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
            {t('prototypeFeedback.retry')}
          </button>
        </div>
      </div>
    )
  }

  const feedback = query.data
  return (
    <>
      <div className="dialog-body space-y-4" data-testid="feedback-list">
        <ReadNotes feedback={feedback} />
        {groups.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <MessageSquareText size={20} className="mx-auto text-muted" aria-hidden />
            <p className="text-sm font-medium text-text-strong">{t('prototypeFeedback.emptyTitle')}</p>
            <p className="text-xs text-muted">{t('prototypeFeedback.emptyHint')}</p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted">
              {t('prototypeFeedback.summary', {
                itemsText: t('prototypeFeedback.itemCount', { count: allItems.length }),
                versions: t('prototypeFeedback.versionCount', { count: feedback.versions_read.length }),
                pins: t('prototypeFeedback.pinCount', { count: feedback.pin_count }),
              })}
            </p>
            {groups.map((group) => (
              <GroupSection key={group.route} group={group} allItems={allItems} selected={live} pinTotal={pinTotal}
                onChange={setSelected} />
            ))}
          </>
        )}
      </div>
      {groups.length === 0 ? null : (
        <SelectionBar items={allItems} selected={live} onClear={() => setSelected(new Set())} onIncorporate={onIncorporate} />
      )}
    </>
  )
}
