/**
 * @fileoverview The Product tab's gaps panel (7.104.00, docs/project-workspace.md → Product tab): the questions for the
 * fields the extract could not fill (or, before any extract, one default question per empty field), answered by
 * typing ("Type answers", then "Save answers": `POST …/product-docs/answers`, one `interview` source) or by voice
 * ("Talk it through", only with `features.voice`). Either way the panel then offers "Extract again". The assistant's
 * chat interview stays beside it (owner decision 12). A viewer reads the questions.
 *
 * @module pages/ProjectDetail/ProductGapsPanel
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, HelpCircle, Keyboard, Loader2, MessageCircle, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { openAssistant } from '../../assistant/store/openAssistant'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { serverReason } from '../../lib/errors'
import { isVoiceAvailable } from '../../runtimeConfig'
import ProductCard from './ProductCard'
import { productFieldLabelKey } from './productContextFields'
import { productDocsKey } from './useProjectData'
import ProductVoiceTalk from './voice/ProductVoiceTalk'
import type { ProductContextField } from '../../api/projectTypes'
import type { GapQuestion as Question } from './useProductProposal'
import type { ProductExtract } from './useProductExtract'

/** = POST …/product-docs/answers' caps (shared/product_source_routes.py). */
const MAX_ANSWERS = 12
const MAX_ANSWER_CHARS = 2000

function TypedAnswers({ projectId, questions, proposalId, onSaved, onCancel }: Readonly<{
  projectId: string; questions: readonly Question[]; proposalId: string | undefined; onSaved: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const [answers, setAnswers] = useState<Partial<Record<ProductContextField, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filled = questions
    .map((one) => ({ ...one, answer: (answers[one.field] ?? '').trim() }))
    .filter((one) => one.answer !== '')
    .slice(0, MAX_ANSWERS)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await projectsApi.saveProductAnswers(projectId, { ...(proposalId === undefined ? {} : { proposal_id: proposalId }), mode: 'typed', answers: filled })
      onSaved()
    } catch (failure: unknown) {
      setError(t('product.gaps.errors.save', { message: serverReason(failure) ?? t('product.sources.errors.tryAgain') }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      {questions.map((one) => (
        <label key={one.field} className="block space-y-1">
          <span className="block text-sm text-text">{one.question}</span>
          <span className="block text-[12px] text-muted">{t(productFieldLabelKey(one.field))}</span>
          <textarea rows={2} className="input w-full resize-y" maxLength={MAX_ANSWER_CHARS} value={answers[one.field] ?? ''} disabled={busy}
            onChange={(event) => setAnswers((current) => ({ ...current, [one.field]: event.target.value }))} />
        </label>
      ))}
      {error === null ? null : <p role="alert" className="text-xs text-danger">{error}</p>}
      <StickyActionBar variant="footer" className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || filled.length === 0} onClick={() => { void save() }}>
          {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {t(busy ? 'product.gaps.saving' : 'product.gaps.save')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>{t('product.gaps.cancel')}</button>
      </StickyActionBar>
    </div>
  )
}

function SavedLine({ extract }: Readonly<{ extract: ProductExtract }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div role="status" className="space-y-2">
      <p className="flex items-center gap-1 text-xs text-ok"><CheckCircle2 size={12} aria-hidden="true" />{t('product.gaps.saved')}</p>
      <button type="button" className="btn btn-secondary btn-sm" disabled={extract.running || extract.pending} onClick={() => extract.start()}>
        <Sparkles size={14} aria-hidden="true" />{t('product.gaps.extractAgain')}
      </button>
    </div>
  )
}

function AnswerActions({ projectId, projectName, questions, onType, onSaved }: Readonly<{
  projectId: string; projectName: string; questions: readonly Question[]; onType: () => void; onSaved: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-secondary btn-sm" onClick={onType}>
        <Keyboard size={14} aria-hidden="true" />{t('product.gaps.type')}
      </button>
      {isVoiceAvailable() ? <ProductVoiceTalk projectId={projectId} projectName={projectName} questions={questions} onSourceSaved={onSaved} /> : null}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openAssistant({ prompt: t('product.assistant.prompt') })}>
        <MessageCircle size={14} aria-hidden="true" />{t('product.gaps.chat')}
      </button>
    </div>
  )
}

export default function ProductGapsPanel({ projectId, projectName, questions, proposalId, canEdit, extract, typing, onTypingChange }: Readonly<{
  projectId: string
  projectName: string
  questions: readonly Question[]
  /** The open proposal whose questions these are, when they are its own. */
  proposalId: string | undefined
  canEdit: boolean
  extract: ProductExtract
  /** The typed answers are open (the empty Sources card's "Answer questions" opens them too). */
  typing: boolean
  onTypingChange: (typing: boolean) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)
  const onSaved = () => {
    setSaved(true)
    onTypingChange(false)
    void queryClient.invalidateQueries({ queryKey: productDocsKey(projectId) })
  }
  if (questions.length === 0) return null
  return (
    <ProductCard icon={HelpCircle} title={t('product.gaps.title')}
      description={t(proposalId === undefined ? 'product.gaps.defaultDescription' : 'product.gaps.description')}>
      {typing && canEdit ? (
        <TypedAnswers projectId={projectId} questions={questions} proposalId={proposalId} onSaved={onSaved} onCancel={() => onTypingChange(false)} />
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-text">
          {questions.map((one) => <li key={one.field}>{one.question}</li>)}
        </ol>
      )}
      {canEdit && !typing ? (
        <AnswerActions projectId={projectId} projectName={projectName} questions={questions}
          onType={() => { setSaved(false); onTypingChange(true) }} onSaved={onSaved} />
      ) : null}
      {canEdit && saved ? <SavedLine extract={extract} /> : null}
    </ProductCard>
  )
}
