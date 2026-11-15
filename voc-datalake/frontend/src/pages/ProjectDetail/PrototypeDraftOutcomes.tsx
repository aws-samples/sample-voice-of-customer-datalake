/**
 * A feedback draft in the banner (docs/prototype-builder.md Part 3): per selected item, **Done** and what changed
 * or **Not done** and why (the model's words, plain text), how many selected pins were withheld, and after Apply
 * the one-line result of its marks and replies. Items are named from the feedback read the Feedback dialog uses
 * (the same query: no extra request once the dialog has loaded it).
 *
 * @module pages/ProjectDetail/PrototypeDraftOutcomes
 */
import { CheckCircle2, CircleSlash, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Incorporation, PinOutcome, PrototypeDraft } from '../../api/prototypeDraftSchema'
import { usePinPlaces } from '../../components/PrototypeFeedback/pinPlaces'
import type { PinPlace } from '../../components/PrototypeFeedback/pinPlaces'
import { outcomeNumber, outcomeRows } from './draftOutcomes'

/** How much of a tester's words names an item in a row. */
const PLACE_TEXT_CHARS = 60

/** Why Apply could not mark or reply to a pin: the server's codes, each worded here; any other reads as "other". */
const NOT_WRITTEN_REASONS = ['pin_gone', 'already_addressed', 'already_resolved', 'thread_full', 'note_withheld', 'reopened'] as const

function reasonText(code: string, t: TFunction<'projectDetail'>): string {
  const known = NOT_WRITTEN_REASONS.find((reason) => reason === code)
  return t(`documents.prototype.draft.notWrittenReason.${known ?? 'other'}`)
}

function placeText(place: PinPlace | null, index: number, t: TFunction<'projectDetail'>): string {
  if (place === null) return t('documents.prototype.draft.outcomePin', { n: index })
  const flat = place.text.replace(/\s+/g, ' ').trim()
  const text = flat.length > PLACE_TEXT_CHARS ? `${flat.slice(0, PLACE_TEXT_CHARS - 1)}…` : flat
  return t('documents.prototype.draft.outcomeItem', { screen: place.screen || t('documents.prototype.draft.noScreen'), text })
}

/** The per-item outcomes and the withheld count of a feedback draft; nothing for an instruction's draft. */
export function DraftOutcomes({ projectId, documentId, draft }: Readonly<{ projectId: string; documentId: string; draft: PrototypeDraft }>) {
  const { t } = useTranslation('projectDetail')
  const places = usePinPlaces(projectId, documentId, draft.kind === 'feedback')
  if (draft.kind !== 'feedback') return null
  const rows = outcomeRows(draft.outcomes, places)
  return (
    <div className="space-y-1.5" data-testid="draft-outcomes">
      <p className="font-medium">{t('documents.prototype.draft.outcomesLabel')}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-1.5 break-words min-w-0">
            {row.outcome === 'done'
              ? <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-ok" aria-hidden />
              : <CircleSlash size={14} className="mt-0.5 flex-shrink-0 text-warn" aria-hidden />}
            <span className="min-w-0">
              <span className="font-medium">
                {row.outcome === 'done' ? t('documents.prototype.draft.done') : t('documents.prototype.draft.notDone')}
              </span>{' '}
              <span className="text-muted">{placeText(row.place, row.index, t)}</span>
              {/* The model's note, as text. */}
              {row.note === '' ? null : <span className="block">{row.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      {draft.withheld.length > 0
        ? <p className="text-warn">{t('documents.prototype.draft.withheld', { count: draft.withheld.length })}</p>
        : null}
    </div>
  )
}

/**
 * After a feedback draft's Apply: what it marked and replied to, and each pin it could not (with the server's
 * reason). The version stands either way; the line stays until dismissed.
 */
export function IncorporationResult({ projectId, documentId, version, incorporation, outcomes, onDismiss }: Readonly<{
  projectId: string; documentId: string; version: number | undefined; incorporation: Incorporation
  /** The applied draft's outcomes: a pin the read does not list is numbered by its place there, as in the banner. */
  outcomes: readonly PinOutcome[]
  onDismiss: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const places = usePinPlaces(projectId, documentId, incorporation.not_written.length > 0)
  const counts = {
    marked: t('documents.prototype.draft.markedCount', { count: incorporation.marked.length }),
    replied: t('documents.prototype.draft.repliedCount', { count: incorporation.replied.length }),
  }
  return (
    <div role="status" data-testid="incorporation-result"
      className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-ok/30 bg-ok-subtle px-3 py-2 text-[13px] text-text min-w-0">
      <div className="min-w-0 space-y-1 break-words">
        <p>
          {version === undefined
            ? t('documents.prototype.draft.incorporationResultNoVersion', counts)
            : t('documents.prototype.draft.incorporationResult', { version, ...counts })}
        </p>
        {incorporation.not_written.length > 0 ? (
          <ul className="space-y-0.5 text-warn">
            {incorporation.not_written.map((entry) => (
              <li key={entry.pin_id}>
                {t('documents.prototype.draft.notWritten', {
                  place: placeText(places.get(entry.pin_id) ?? null, outcomeNumber(outcomes, entry.pin_id), t),
                  reason: reasonText(entry.reason, t),
                })}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <button type="button" className="icon-btn p-1 flex-shrink-0" aria-label={t('documents.prototype.draft.dismissResult')}
        title={t('documents.prototype.draft.dismissResult')} onClick={onDismiss}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
