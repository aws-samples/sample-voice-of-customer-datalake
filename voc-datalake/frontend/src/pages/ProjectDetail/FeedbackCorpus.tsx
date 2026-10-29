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
 * @module pages/ProjectDetail/FeedbackCorpus
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import FeedbackCorpusModal from './FeedbackCorpusModal'
import { corpusIds } from './feedbackCorpusIds'

interface FeedbackCorpusProps {
  readonly feedbackIds: readonly string[] | undefined
  readonly className?: string
}

export default function FeedbackCorpus({ feedbackIds, className }: FeedbackCorpusProps) {
  const { t } = useTranslation('projectDetail')
  const ids = useMemo(() => corpusIds(feedbackIds), [feedbackIds])
  const [open, setOpen] = useState(false)
  if (ids.length === 0) return null
  return (
    <p data-testid="feedback-corpus" className={className ?? 'flex flex-wrap items-center gap-x-2 text-xs text-muted'}>
      <span>{t('corpus.summary', { count: ids.length })}</span>
      <button type="button" className="link" onClick={() => setOpen(true)}>{t('corpus.show')}</button>
      {open ? <FeedbackCorpusModal ids={ids} onClose={() => setOpen(false)} /> : null}
    </p>
  )
}
