/**
 * @fileoverview PR/FAQ row component for the prioritization table.
 * @module pages/Prioritization/PRFAQRow
 */

import clsx from 'clsx'
import { format } from 'date-fns'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import LinkedFormEvidence from './LinkedFormEvidence'
import { PREVIEW_MARKDOWN_COMPONENTS } from './previewMarkdown'
import RoomVotePanel from './RoomVotePanel'
import RowCompositionPanel from './RowCompositionPanel'
import { RowLineageBadge, RowLineageNote, RowStaleBadge } from './RowLineagePanels'
import { MAX_NOTE_LENGTH, SCORABLE_TYPE_META } from './prioritizationUtils'
import type { PrioritizationRowView } from './prioritizationUtils'
import { getPriorityLabel } from './teamScore'
import type { TeamView } from './teamScore'
import ScoreSlider from './ScoreSlider'
import type { RowCompositionActions } from './RowCompositionPanel'
import type { LinkedForm } from './formLinkUtils'
import type { PrioritizationScore, ProjectDocument } from '../../api/types'
import type { TFunction } from 'i18next'
import type { ReactElement } from 'react'
import { TeamScoreSummary, DisagreementBadge, TeamScorePanel } from './RowTeamScore'
import { PrototypePanel } from './RowPrototypePanel'

/**
 * Resolved-value badge — receives a pre-computed label and colour from the
 * parent (which already has `t` in scope) instead of calling `useTranslation`
 * itself. Consistent with `PrototypePanel`, which accepts `t` as a prop for
 * the same reason.
 */
function DocumentTypeBadge({
  label, color,
}: {
  readonly label: string
  readonly color: string
}): ReactElement {
  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', color)}>{label}</span>
  )
}

/**
 * One badge per document the row is scored on.
 *
 * A row holds a SET of documents, so the collapsed row says which — a reviewer
 * scoring "Instant refunds" needs to know their one ballot covers its PR/FAQ and its
 * PRD, which is precisely what having two rows for one idea used to hide.
 */
function RowDocumentBadges({
  documents, t,
}: {
  readonly documents: readonly ProjectDocument[]
  readonly t: TFunction
}): ReactElement {
  return (
    <>
      {documents.map((doc) => {
        // Resolved here so DocumentTypeBadge is a pure presentational component
        // (consistent with PrototypePanel's t-as-prop pattern).
        const typeMeta = SCORABLE_TYPE_META[doc.document_type]
        return (
          <DocumentTypeBadge
            key={doc.document_id}
            label={typeMeta ? t(typeMeta.i18nKey) : doc.document_type}
            color={typeMeta?.badgeColor ?? 'bg-bg-hover text-text'}
          />
        )
      })}
    </>
  )
}

function PRFAQRowHeader({
  row,
  index,
  priority,
  team,
  isExpanded,
  onToggle,
}: {
  readonly row: PrioritizationRowView
  readonly index: number
  readonly priority: {
    label: string;
    color: string
  }
  readonly team: TeamView
  readonly isExpanded: boolean
  readonly onToggle: () => void
}) {
  const { t } = useTranslation('prioritization')
  return (
    <button type="button" aria-expanded={isExpanded} className="w-full p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 cursor-pointer hover:bg-bg-hover text-left focus-ring" onClick={onToggle}>
      <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
        <div className="text-muted font-mono text-sm w-6 hidden sm:block">#{index + 1}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-text-strong truncate text-sm sm:text-base" title={row.title}>{row.title}</h3>
            {/* One badge per document, because ONE ballot covers all of them. */}
            <RowDocumentBadges documents={row.documents} t={t} />
            <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', priority.color)}>{priority.label}</span>
            <DisagreementBadge team={team} />
            {/* What these documents say about EACH OTHER, beside the number they
                produced: a reviewer ranking a backlog is choosing which rows to
                open, and "the evidence behind this row is one generation" is
                exactly what the ranked list could not say. Never a gate — every
                state stays scorable and keeps every control. */}
            <RowLineageBadge lineage={row.lineage} />
            {/* And, for a FROZEN row only, that the project has moved past the
                documents its ballots were cast on. Its own badge rather than a
                fourth lineage state, because a coherent row can be superseded —
                see `RowStaleBadge`. */}
            <RowStaleBadge lineage={row.lineage} />
          </div>
          <div className="flex items-center gap-2 sm:gap-3 mt-1 text-xs sm:text-sm text-muted">
            <span className="truncate">{row.project_name}</span>
            <span>•</span>
            <span className="whitespace-nowrap">{format(new Date(row.created_at), 'MMM d, yyyy')}</span>
            {/* Says plainly what one ballot covers, next to the badges that name
                the documents. Without it, a row showing two badges leaves a reader
                to guess whether they are scoring both or picking one.
                Only for a row that HOLDS more than one: on a single-document row
                there is nothing to clarify, and it lets the sentence be written in
                the plural rather than through a `count` plural — whose forms differ
                per locale, and a missing one renders the raw key path.
                `documents`, not `count`: `count` is i18next's RESERVED option and
                passing it switches the resolver into plural mode, looking for
                `_one`/`_other` first. */}
            {row.documents.length > 1 ? (
              <>
                <span className="hidden sm:inline">•</span>
                <span className="hidden sm:inline whitespace-nowrap">
                  {t('row.multiDocument', { documents: row.documents.length })}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <TeamScoreSummary team={team} />
      <div className="sm:ml-2">{isExpanded ? <ChevronUp size={16} className="text-muted" aria-hidden="true" /> : <ChevronDown size={16} className="text-muted" aria-hidden="true" />}</div>
    </button>
  )
}

/**
 * One document of the row, inside the expansion: its type, its text, and the
 * customer evidence collected about IT.
 *
 * Per document rather than merged into the row, because the evidence belongs to the
 * document a form validates — a PR/FAQ's ratings shown under its project's PRD is the
 * confusion `formLinkUtils`' matching rules exist to prevent — and because a reviewer
 * casting one ballot on a set is entitled to read each thing in it.
 */
function RowDocument({
  document: doc, projectId, linkedForms, apiEndpoint, t,
}: {
  readonly document: ProjectDocument
  readonly projectId: string
  readonly linkedForms: readonly LinkedForm[]
  readonly apiEndpoint: string
  readonly t: TFunction
}): ReactElement {
  const typeMeta = SCORABLE_TYPE_META[doc.document_type]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <DocumentTypeBadge
            label={typeMeta ? t(typeMeta.i18nKey) : doc.document_type}
            color={typeMeta?.badgeColor ?? 'bg-bg-hover text-text'}
          />
          <span className="text-sm font-medium text-text-strong truncate" title={doc.title}>{doc.title}</span>
        </div>
        {/* The project, not the document: the document route on this app is the
            project page, and that is where the full text lives. */}
        <a href={`/projects/${projectId}`} className="text-sm link flex items-center gap-1 flex-shrink-0">
          <span className="hidden sm:inline">{t('preview.viewFull')}</span>
          <span className="sm:hidden">{t('preview.viewMobile')}</span>
          <ExternalLink size={14} />
        </a>
      </div>
      <div className="bg-card rounded-lg border p-3 sm:p-4 max-h-48 sm:max-h-64 overflow-y-auto md-content">
        <ReactMarkdown components={PREVIEW_MARKDOWN_COMPONENTS}>{doc.content.slice(0, 1500) + (doc.content.length > 1500 ? '...' : '')}</ReactMarkdown>
      </div>
      {/* Ratings already collected about THIS document. Mounted expand-only because
          the stats read is expensive per form — see LinkedFormEvidence. */}
      <LinkedFormEvidence forms={linkedForms} apiEndpoint={apiEndpoint} />
    </div>
  )
}

function PRFAQRowExpanded({
  row, score, team, linkedFormsByDocument, apiEndpoint, composition, onUpdateScore,
}: {
  readonly row: PrioritizationRowView
  readonly score: PrioritizationScore
  readonly team: TeamView
  /** Per DOCUMENT, not per row — see `RowDocument`. */
  readonly linkedFormsByDocument: ReadonlyMap<string, readonly LinkedForm[]>
  readonly apiEndpoint: string
  /** What may be done to this row's COMPOSITION — see `RowCompositionPanel`. */
  readonly composition: RowCompositionActions
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  return (
    <div className="border-t px-3 sm:px-4 py-4 bg-bg-accent">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="space-y-4">
          <TeamScorePanel team={team} />
          <div>
            <h4 className="font-medium text-text-strong">{t('scores.title')}</h4>
            {/* Says whose numbers these are. The row's headline is the team's mean
                now, so the sliders need to name themselves as the reader's own
                ballot — and to say that saving writes only that. */}
            <p className="text-xs text-muted mt-1">{t('scores.yoursOnly')}</p>
            {/* And WHAT they score: one ballot on this row's whole set of documents.
                A reviewer who thought a slider scored only the document they were
                reading is exactly who was scoring half an idea before rows. Shown
                only for a row holding more than one, for the reason the header's
                own count is. */}
            {row.documents.length > 1 ? (
              <p className="text-xs text-muted mt-1">
                {t('scores.wholeRow', { documents: row.documents.length })}
              </p>
            ) : null}
          </div>
          {/* The stored value goes in RAW: 0 means unscored (the API's own
              contract) and `ScoreSlider` renders it as such. The old
              `=== 0 ? 3` coercion here painted a mid-range number the record
              did not hold, indistinguishable from a stored 3 — so a reviewer
              whose partial save recorded three axes as nothing could never
              discover it on screen (#343). */}
          <ScoreSlider label={t('scores.impact')} value={score.impact} onChange={(v) => onUpdateScore('impact', v)} description={t('scores.impactDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <ScoreSlider label={t('scores.timeToMarket')} value={score.time_to_market} onChange={(v) => onUpdateScore('time_to_market', v)} description={t('scores.timeToMarketDescription')} lowLabel={t('scores.slow')} highLabel={t('scores.fast')} />
          <ScoreSlider label={t('scores.strategicFit')} value={score.strategic_fit} onChange={(v) => onUpdateScore('strategic_fit', v)} description={t('scores.strategicFitDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <ScoreSlider label={t('scores.confidence')} value={score.confidence} onChange={(v) => onUpdateScore('confidence', v)} description={t('scores.confidenceDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <div>
            <label className="text-sm font-medium text-text">{t('notes.label')}</label>
            {/* Bounded, because the API REFUSES a longer note rather than
                truncating it — the tail of a justification is content, not a
                number that can be clamped. Without this the page could compose a
                body the save would reject, and `fetchApi` discards the reason. A
                note already over the bound in pre-ballot data is not shortened by
                `maxLength`; `overLongNoteRows` blocks the save for it. */}
            <textarea value={score.notes} onChange={(e) => onUpdateScore('notes', e.target.value)} placeholder={t('notes.placeholder')} rows={2} maxLength={MAX_NOTE_LENGTH} className="input mt-1" />
          </div>
          {/* Get the ROOM's ballots, not just this reader's: a facilitator opens a
              session for this ROW and the QR goes on the projector, so a room scores
              the whole proposal rather than whichever of its documents the code sat
              on. Under the caller's own sliders because it is the other way to put a
              score in, and above the customer evidence because it is still internal
              scoring. Mounted expand-only, like everything else in this column — it
              opens nothing and reads nothing until a facilitator asks. */}
          <RoomVotePanel rowId={row.row_id} rowTitle={row.title} documentCount={row.documents.length} />
        </div>
        <div className="space-y-4">
          {/* Directly above the documents it composes, and in the column that shows
              them, because that is what the panel is about: which documents this one
              ballot covers. The scoring column is deliberately untouched — a frozen
              row stays scoreable, and only its composition stops changing. */}
          <RowCompositionPanel row={row} composition={composition} />
          {/* The badge's reason in full, and — for a stale frozen row — the action
              that IS available, directly under the "Add row" button it names. The
              header's copy of the reason is announced rather than printed, because
              a sentence per row would bury the numbers beside it; this is where a
              sighted reader reads it. */}
          <RowLineageNote lineage={row.lineage} />
          <h4 className="font-medium text-text-strong">{t('preview.title')}</h4>
          {/* Every document the row is scored on, each with its own evidence. Newest
              first, which is the order `collectRows` resolved them in and the order
              the leading title came from. */}
          {row.documents.map((doc) => (
            <RowDocument
              key={doc.document_id}
              document={doc}
              projectId={row.project_id}
              linkedForms={linkedFormsByDocument.get(doc.document_id) ?? NO_LINKED_FORMS}
              apiEndpoint={apiEndpoint}
              t={t}
            />
          ))}
          {/* Prototype preview, under the row's documents. HTML prototypes render in
              a sandboxed iframe; legacy JSON specs render natively. Hidden gracefully
              when the row names no prototype the project still has. */}
          <PrototypePanel prototype={row.prototype} t={t} />
        </div>
      </div>
    </div>
  )
}

/** Shared empty list, so a row with no linked forms allocates nothing per render. */
const NO_LINKED_FORMS: readonly LinkedForm[] = []

export default function PRFAQRow({
  row, index, score, team, linkedFormsByDocument, apiEndpoint, composition, isExpanded, onToggle, onUpdateScore,
}: {
  readonly row: PrioritizationRowView
  readonly index: number
  /**
   * The CALLER'S OWN ballot, behind the caller's own sliders in the expansion.
   * Not what the resting row shows — see `team`.
   */
  readonly score: PrioritizationScore
  /**
   * What every reviewer together said — the row's resting state, and the same numbers
   * the list is ordered by.
   *
   * See `TeamView` for the states and what each one licenses the row to say, rather than
   * a count restated here: the count was wrong for four commits after `'loading'` joined
   * the union, and a pointer cannot drift from the type the way a number can.
   */
  readonly team: TeamView
  /**
   * Forms that validate each of the row's documents, keyed by document id — see
   * `formLinkUtils.buildLinkedFormsByDocument`.
   *
   * Per document rather than per row, because a form validates a document and the
   * ratings it collected are about that document. The row is how a reader reaches
   * them.
   */
  readonly linkedFormsByDocument: ReadonlyMap<string, readonly LinkedForm[]>
  /**
   * The configured API base, needed only to address a linked form's public page
   * in `LinkedFormEvidence`. Threaded rather than read from the store there, so
   * that panel and its QR stay renderable without one.
   */
  readonly apiEndpoint: string
  /**
   * What a reviewer may do to this row's COMPOSITION — see `RowCompositionActions`.
   *
   * Threaded whole and row-agnostic, so the list passes one value to every row
   * rather than building three closures per row on every render.
   */
  readonly composition: RowCompositionActions
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  // The priority band describes the TEAM's composite, matching the number beside
  // it and the sort order. The team VIEW is passed whole rather than as
  // `composite ?? 0`, so neither non-scored state reaches the band as a low number:
  // a proposal the team unanimously rated 1 bands "Low Priority", only an unvoted
  // one bands "Not Scored", and a failed read bands as neither. The band also reads
  // the same rounded value the row prints, so label and number cannot disagree.
  const priority = getPriorityLabel(team, t)

  return (
    <div className="bg-card rounded-lg border border-border shadow-sm">
      <PRFAQRowHeader row={row} index={index} priority={priority} team={team} isExpanded={isExpanded} onToggle={onToggle} />
      {isExpanded ? <PRFAQRowExpanded row={row} score={score} team={team} linkedFormsByDocument={linkedFormsByDocument} apiEndpoint={apiEndpoint} composition={composition} onUpdateScore={onUpdateScore} /> : null}
    </div>
  )
}
