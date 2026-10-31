/**
 * @fileoverview "Written from N reviews": the corpus behind a generated persona or document (#236).
 *
 * Reads `input_feedback_ids` (the reviews the generation's prompts held, in prompt order, at most
 * 500), never `source_feedback_ids` (the first 20 fetched, a display-only list). Only ids are stored
 * with the result, so the list is opened one review at a time through `GET /feedback/{id}`
 * (FeedbackCorpusModal); a review that was erased, deleted or is outside the caller's access reads
 * as unavailable. Renders nothing for an artefact without the field (generated before the field
 * existed, imported or written by hand).
 *
 * A persona also has `evidence_feedback_ids` (`citedIds`): the reviews its supporting evidence
 * cites, resolved from the model's "Review #N" at generation (ported from #429 by @aws-bryan).
 * With any, the line says how many it cites and the modal opens on a "Cited" view next to "All used".
 *
 * @module pages/ProjectDetail/FeedbackCorpus
 */
import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import FeedbackCorpusModal from './FeedbackCorpusModal'
import { corpusIds } from './feedbackCorpusIds'

interface FeedbackCorpusProps {
  readonly feedbackIds: readonly string[] | undefined
  /** The ids the artefact cites (a persona's `evidence_feedback_ids`); absent or empty = no Cited view. */
  readonly citedIds?: readonly string[]
  /** Extra classes for the line (its placement, e.g. a top margin); the base look is the component's own. */
  readonly className?: string
}

export default function FeedbackCorpus({ feedbackIds, citedIds, className }: FeedbackCorpusProps) {
  const { t } = useTranslation('projectDetail')
  const ids = useMemo(() => corpusIds(feedbackIds), [feedbackIds])
  const cited = useMemo(() => corpusIds(citedIds), [citedIds])
  const [open, setOpen] = useState(false)
  if (ids.length === 0) return null
  // The modal is a sibling of the line, never inside it: ModalShell renders in place (no portal),
  // and its panel <div>s are not valid content of a <p>.
  return (
    <>
      <p data-testid="feedback-corpus" className={clsx('flex flex-wrap items-center gap-x-2 text-xs text-muted', className)}>
        <span>{t('corpus.summary', { count: ids.length })}</span>
        {cited.length > 0 ? <span>{t('corpus.citedSummary', { count: cited.length })}</span> : null}
        <button type="button" className="link" onClick={() => setOpen(true)}>{t('corpus.show')}</button>
      </p>
      {open ? <FeedbackCorpusModal ids={ids} citedIds={cited} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
