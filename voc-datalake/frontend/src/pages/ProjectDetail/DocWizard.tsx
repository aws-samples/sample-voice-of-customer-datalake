/**
 * @fileoverview The document generation wizard (PRD / PR/FAQ / custom), split from the other project wizards.
 * @module pages/ProjectDetail/DocWizard
 */

import clsx from 'clsx'
import { Check, FileText } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AI_DRAFT_LIMITS } from '../../api/aiDraft'
import AIDraftButton from '../../components/AIDraftButton/AIDraftButton'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DataSourceWizard from '../../components/DataSourceWizard/DataSourceWizard'
import ContextSummary from '../../components/DataSourceWizard/ContextSummary'
import { WizardIconTile } from './Wizards'
import { DocWizardQuestions } from './DocWizardQuestions'
import { useDocWizardDrafts } from './useDocWizardDrafts'
import type { DocToolConfig } from './types'
import type { DocType } from '../../api/types'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ContextConfig } from '../../components/DataSourceWizard/types'

/** An AI draft about to rewrite what the user typed: asked first, Cancel keeps their text. */
function ReplaceDraftConfirm({ replacing, onConfirm, onCancel }: Readonly<{
  replacing: 'brief' | 'answers' | null; onConfirm: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  return (
    <ConfirmModal
      isOpen={replacing !== null}
      variant="warning"
      title={t('wizards.replaceDraftTitle')}
      message={replacing === 'brief' ? t('wizards.replaceBriefMessage') : t('wizards.replaceAnswersMessage')}
      confirmLabel={t('wizards.replaceDraftConfirm')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

interface DocWizardProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly docConfig: DocToolConfig
  readonly generating: string | null
  readonly onContextChange: (c: ContextConfig) => void
  readonly onDocConfigChange: (c: DocToolConfig) => void
  readonly onClose: () => void
  readonly onSubmit: () => void
}

export function DocWizard({
  projectId, personas, documents, contextConfig, docConfig, generating, onContextChange, onDocConfigChange, onClose, onSubmit,
}: DocWizardProps) {
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  const descriptionId = useId()
  const drafts = useDocWizardDrafts({ projectId, docConfig, contextConfig, onDocConfigChange })
  // An AI draft that would REWRITE text the user typed is asked first; into empty fields it just runs.
  const [replacing, setReplacing] = useState<'brief' | 'answers' | null>(null)

  const docTypes = docConfig.docTypes
  const hasPrfaq = docTypes.includes('prfaq')
  const hasPrd = docTypes.includes('prd')

  // `DocType`, not a respelt `'prd' | 'prfaq'` — a convention here, not something a
  // test enforces: the lockstep test reads only the `DocType` declaration and the two
  // api/ clients, never this file. Widening THIS annotation past `DocType` is caught,
  // by the compiler at the `includes`/spread sites below, since `docConfig.docTypes`
  // is `DocType[]`.
  //
  // ⚠️ The REVERSE is not caught, and it is the direction that actually happens: if
  // `DocType` and `GENERATED_DOC_TYPES` are widened together, nothing here fails.
  // `tsc` is fine with a narrower argument to `includes`/`filter`, so the picker
  // silently keeps offering the old set — measured: adding a third member to both
  // leaves `tsc -b` clean and every lockstep test green with this file untouched.
  // Adding a doc type therefore means editing this file too, in four places that name
  // their members as literals: `hasPrfaq`/`hasPrd` above, the two `toggleDocType('…')`
  // buttons in `renderFinalStep`, the `bothSelected`/`singleTitle`/`singleSubmitLabel`
  // copy, which is written as a PRD-or-PR/FAQ binary — a third member would fall into
  // its PR/FAQ branch and be labelled as one — and `useDocWizardDrafts`' brief's
  // `doc_type: … includes('prd') ? 'prd' : 'prfaq'`, the same binary against a
  // DIFFERENT route: a third member selected alone asks `suggest-brief` for a PR/FAQ
  // brief, so the AI-drafted title and description come back framed as a PR/FAQ for a
  // document that is not one. That call is the only place the picker's set meets
  // `suggestDocumentBrief`'s, which is deliberately left unbound to `DocType` (its
  // signature and the reason sit at `api/projectsApi.ts`), so it needs naming rather
  // than leaving implied by "unbound".
  //
  // The lockstep test's module docstring carries the same list as the FOURTH edit a
  // widening needs, so a widener reading either place learns it; keep the two
  // consistent (issue #381).
  const toggleDocType = (type: DocType) => {
    const next = docTypes.includes(type)
      ? docTypes.filter((d) => d !== type)
      : [...docTypes, type]
    onDocConfigChange({ ...docConfig, docTypes: next })
  }

  const updateQuestion = (index: number, value: string) => {
    const newQuestions = [...docConfig.customerQuestions]
    newQuestions[index] = value
    onDocConfigChange({
      ...docConfig,
      customerQuestions: newQuestions,
    })
  }

  const docCount = docTypes.length
  const bothSelected = hasPrd && hasPrfaq
  const hasTitle = docConfig.title.trim() !== ''
  const hasDescription = docConfig.featureIdea.trim() !== ''
  const hasBriefText = hasTitle || hasDescription
  const hasAnswerText = docConfig.customerQuestions.some((answer) => answer.trim() !== '')
  const askBrief = () => { if (hasBriefText) setReplacing('brief'); else void drafts.brief.run() }
  const askAnswers = () => { if (hasAnswerText) setReplacing('answers'); else void drafts.answers.run() }
  const confirmReplace = () => {
    setReplacing(null)
    void (replacing === 'brief' ? drafts.brief.run() : drafts.answers.run())
  }

  const singleTitle = hasPrd
    ? t('wizards.generatePrdTitle', { defaultValue: 'Generate PRD' })
    : t('wizards.generatePrfaqTitle', { defaultValue: 'Generate PR/FAQ' })
  const wizardTitle = bothSelected
    ? t('wizards.generateBothTitle', { defaultValue: 'Generate PRD + PR/FAQ' })
    : singleTitle

  const singleSubmitLabel = hasPrd
    ? t('wizards.generatePrd', { defaultValue: 'Generate PRD' })
    : t('wizards.generatePrfaq', { defaultValue: 'Generate PR/FAQ' })
  const submitLabelText = bothSelected
    ? t('wizards.generateBoth', { defaultValue: 'Generate PRD + PR/FAQ' })
    : singleSubmitLabel

  return (
    <DataSourceWizard
      title={wizardTitle}
      icon={<WizardIconTile icon={FileText} />}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-1">{t('wizards.documentType', { defaultValue: 'Document Type' })}</h3>
            <p className="text-xs text-muted mb-3">{t('wizards.documentTypeHint', { defaultValue: 'Select one or both — both are generated at once.' })}</p>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => toggleDocType('prfaq')} aria-pressed={hasPrfaq} className={clsx('p-4 rounded-lg border text-left relative focus-ring', hasPrfaq ? 'bg-accent-subtle border-accent' : 'bg-card border-border')}>
                {hasPrfaq ? <Check size={14} aria-hidden="true" className="absolute top-2 right-2 text-accent-text" /> : null}
                <div className="font-medium">{t('wizards.prfaqLabel', { defaultValue: 'PR/FAQ' })}</div>
                <div className="text-sm text-muted">{t('wizards.prfaqDesc', { defaultValue: 'Amazon-style Press Release & FAQ' })}</div>
              </button>
              <button type="button" onClick={() => toggleDocType('prd')} aria-pressed={hasPrd} className={clsx('p-4 rounded-lg border text-left relative focus-ring', hasPrd ? 'bg-accent-subtle border-accent' : 'bg-card border-border')}>
                {hasPrd ? <Check size={14} aria-hidden="true" className="absolute top-2 right-2 text-accent-text" /> : null}
                <div className="font-medium">{t('wizards.prdLabel', { defaultValue: 'PRD' })}</div>
                <div className="text-sm text-muted">{t('wizards.prdDesc', { defaultValue: 'Product Requirements Document' })}</div>
              </button>
            </div>
          </div>
          <div>
            <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
              <h3 id={titleId} className="font-medium">{t('wizards.featureTitle', { defaultValue: 'Feature/Product Title' })}</h3>
              <AIDraftButton
                subject={t('wizards.briefSubject')}
                hasText={hasBriefText}
                busy={drafts.brief.busy}
                onClick={askBrief}
                hint={t('wizards.briefTitle')}
                error={drafts.brief.error}
              />
            </div>
            <input type="text" aria-labelledby={titleId} value={docConfig.title} onChange={(e) => onDocConfigChange({
              ...docConfig,
              title: e.target.value,
            })} maxLength={AI_DRAFT_LIMITS.title} placeholder={t('wizards.featureTitlePlaceholder', { defaultValue: 'e.g., Real-time Delivery Tracking' })} className="input" />
          </div>
          <div>
            <h3 id={descriptionId} className="font-medium mb-3">{t('wizards.featureDescription', { defaultValue: 'Feature Description' })}</h3>
            <textarea aria-labelledby={descriptionId} value={docConfig.featureIdea} onChange={(e) => onDocConfigChange({
              ...docConfig,
              featureIdea: e.target.value,
            })} maxLength={AI_DRAFT_LIMITS.description} placeholder={t('wizards.featureDescriptionPlaceholder', { defaultValue: 'Describe the feature...' })} rows={4} className="input" />
          </div>
          {hasPrfaq ? (
            <DocWizardQuestions
              answers={docConfig.customerQuestions}
              onAnswerChange={updateQuestion}
              draft={drafts.answers}
              briefReady={hasTitle && hasDescription}
              onDraft={askAnswers}
            />
          ) : null}
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
          <ReplaceDraftConfirm replacing={replacing} onConfirm={confirmReplace} onCancel={() => setReplacing(null)} />
        </div>
      )}
      finalStepValid={hasTitle && hasDescription && docCount > 0}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'doc'}
      submitLabel={<><FileText size={16} />{submitLabelText}</>}
    />
  )
}
