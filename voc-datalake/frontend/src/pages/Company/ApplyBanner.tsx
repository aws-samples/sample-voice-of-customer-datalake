/**
 * @fileoverview The banner shown after "Use as design system": which reference
 * the editor now holds, what it changes (new / updated per token group and for
 * components, the guidelines), and Save / Discard. Nothing is stored until Save. Save is a
 * secondary button: the card's own Save Changes row stays its one primary action.
 *
 * @module pages/Company/ApplyBanner
 */
import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wand2 } from 'lucide-react'
import type { ComponentChange, DraftSummary, GroupChange, TokenGroup } from './designDraftSummary'

export interface AppliedReference {
  source: string
  summary: DraftSummary
}

const GROUP_LABEL_KEYS: Record<TokenGroup, string> = {
  colors: 'designSystem.colors',
  typography: 'designSystem.typography',
  spacing: 'designSystem.spacing',
  radius: 'designSystem.radius',
}

type Translate = ReturnType<typeof useTranslation>['t']

/** "Colors: 6 new, 2 updated" — a side with nothing is left out ("Colors: 6 new"). */
function groupLine(change: GroupChange, t: Translate): string {
  const values = { group: t(GROUP_LABEL_KEYS[change.group]), added: change.added, replaced: change.replaced }
  if (change.replaced === 0) return t('designSystem.applied.groupAdded', values)
  if (change.added === 0) return t('designSystem.applied.groupReplaced', values)
  return t('designSystem.applied.group', values)
}

/** "Components: 3 new · 1 updated" — a side with nothing is left out. */
function componentsLine(change: ComponentChange, t: Translate): string {
  const parts = [
    change.added > 0 ? t('designSystem.applied.componentsAdded', { count: change.added }) : null,
    change.replaced > 0 ? t('designSystem.applied.componentsReplaced', { count: change.replaced }) : null,
  ].filter((part) => part !== null)
  return t('designSystem.applied.components', { changes: parts.join(' · ') })
}

export default function ApplyBanner({ applied, saving, saveFailed, onSave, onDiscard }: Readonly<{
  applied: AppliedReference
  saving: boolean
  saveFailed: boolean
  onSave: () => void
  onDiscard: () => void
}>) {
  const { t } = useTranslation('settings')
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // Applying happens in the references card further down: bring the result into view.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    ref.current?.focus({ preventScroll: true })
  }, [applied])
  const { summary } = applied

  return (
    <div ref={ref} tabIndex={-1} role="region" aria-labelledby={titleId} className="rounded-md border border-aim/30 bg-aim-subtle p-3 space-y-2 outline-none">
      <p id={titleId} className="text-sm font-medium text-text-strong flex items-center gap-1.5">
        <Wand2 size={14} className="text-aim flex-shrink-0" />
        {summary.changed ? t('designSystem.applied.title', { source: applied.source }) : t('designSystem.applied.nothingNew', { source: applied.source })}
      </p>
      {summary.changed ? (
        <ul className="text-xs text-text list-disc pl-5 space-y-0.5">
          {summary.groups.map((change) => (
            <li key={change.group}>
              {groupLine(change, t)}
            </li>
          ))}
          {summary.components.added + summary.components.replaced > 0 ? <li>{componentsLine(summary.components, t)}</li> : null}
          {summary.guidelinesChanged ? <li>{t('designSystem.applied.guidelines')}</li> : null}
        </ul>
      ) : null}
      {saveFailed ? <p role="alert" className="text-xs text-danger">{t('designSystem.applied.saveFailed')}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {summary.changed ? (
          <button type="button" onClick={onSave} disabled={saving} className="btn btn-secondary btn-sm flex items-center gap-1.5">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {t('designSystem.applied.save')}
          </button>
        ) : null}
        <button type="button" onClick={onDiscard} disabled={saving} className="btn btn-ghost btn-sm">
          {summary.changed ? t('designSystem.applied.discard') : t('designSystem.applied.dismiss')}
        </button>
      </div>
    </div>
  )
}
