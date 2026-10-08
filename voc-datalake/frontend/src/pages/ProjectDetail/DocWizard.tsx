/**
 * @fileoverview The document generation wizard (PRD / PR-FAQ / custom), split from the other project wizards.
 * @module pages/ProjectDetail/DocWizard
 */

import clsx from 'clsx'
import { AlertTriangle, Check, FileText, Loader2, Wand2 } from 'lucide-react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import DataSourceWizard from '../../components/DataSourceWizard/DataSourceWizard'
import ContextSummary from '../../components/DataSourceWizard/ContextSummary'
import type { DocToolConfig } from './types'
import type { DocType } from '../../api/types'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ContextConfig } from '../../components/DataSourceWizard/types'
import { lenientList } from '../../api/lenientFields'

/** The clarifying-question answers, read leniently: one bad item costs itself. */
const isString = (item: unknown): item is string => typeof item === 'string'
const answerList = lenientList(isString)

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
  const { t, i18n } = useTranslation('projectDetail')
  const [autofilling, setAutofilling] = useState(false)
  const [autofillError, setAutofillError] = useState<string | null>(null)
  const [briefing, setBriefing] = useState(false)
  const [briefError, setBriefError] = useState<string | null>(null)

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
  // copy, which is written as a PRD-or-PR-FAQ binary — a third member would fall into
  // its PR-FAQ branch and be labelled as one — and `onSuggestBrief`'s
  // `doc_type: … includes('prd') ? 'prd' : 'prfaq'`, the same binary against a
  // DIFFERENT route: a third member selected alone asks `suggest-brief` for a PR-FAQ
  // brief, so the AI-drafted title and description come back framed as a PR-FAQ for a
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

  // AI-draft the feature title + description from project context so the user
  // doesn't start from an empty box.
  const onSuggestBrief = useCallback(async () => {
    setBriefing(true)
    setBriefError(null)
    try {
      const r = await projectsApi.suggestDocumentBrief(projectId, {
        doc_type: docConfig.docTypes.includes('prd') ? 'prd' : 'prfaq',
        response_language: i18n.language,
      })
      onDocConfigChange({
        ...docConfig,
        title: r.title || docConfig.title,
        featureIdea: r.feature_idea || docConfig.featureIdea,
      })
      if (!r.title && !r.feature_idea) {
        setBriefError(t('wizards.briefEmpty', { defaultValue: 'No draft — add or collect more feedback first.' }))
      }
    } catch (e: unknown) {
      setBriefError(e instanceof Error ? e.message : 'Draft failed')
    } finally {
      setBriefing(false)
    }
  }, [projectId, docConfig, i18n.language, onDocConfigChange, t])

  // Amazon's 5 Customer Questions for Working Backwards PR-FAQ. Pulled from
  // i18n so the entire wizard matches the user's chosen language (the labels
  // were hardcoded English even when the rest of the UI was Korean).
  const amazonQuestions = [1, 2, 3, 4, 5].map((n) => ({
    title: t(`wizards.question${n}Title`),
    description: t(`wizards.question${n}Desc`),
    placeholder: t(`wizards.question${n}Placeholder`),
  }))

  const onAutofill = useCallback(async () => {
    setAutofilling(true)
    setAutofillError(null)
    try {
      const r = await projectsApi.autofillPrfaqQuestions(projectId, {
        feature_idea: docConfig.featureIdea,
        title: docConfig.title,
        response_language: i18n.language,
      })
      const answers = answerList.parse(r.answers).slice(0, 5)
      const padded: string[] = [...answers, '', '', '', '', ''].slice(0, 5)
      onDocConfigChange({ ...docConfig, customerQuestions: padded })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Autofill failed'
      setAutofillError(msg)
    } finally {
      setAutofilling(false)
    }
  }, [projectId, docConfig, i18n.language, onDocConfigChange])

  const docCount = docTypes.length
  const bothSelected = hasPrd && hasPrfaq

  const singleTitle = hasPrd
    ? t('wizards.generatePrdTitle', { defaultValue: 'Generate PRD' })
    : t('wizards.generatePrfaqTitle', { defaultValue: 'Generate PR-FAQ' })
  const wizardTitle = bothSelected
    ? t('wizards.generateBothTitle', { defaultValue: 'Generate PRD + PR-FAQ' })
    : singleTitle

  const singleSubmitLabel = hasPrd
    ? t('wizards.generatePrd', { defaultValue: 'Generate PRD' })
    : t('wizards.generatePrfaq', { defaultValue: 'Generate PR-FAQ' })
  const submitLabelText = bothSelected
    ? t('wizards.generateBoth', { defaultValue: 'Generate PRD + PR-FAQ' })
    : singleSubmitLabel

  return (
    <DataSourceWizard
      title={wizardTitle}
      accentColor="info"
      icon={<div className="w-10 h-10 bg-info-subtle rounded-lg flex items-center justify-center"><FileText size={20} className="text-info" /></div>}
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
              <button type="button" onClick={() => toggleDocType('prfaq')} aria-pressed={hasPrfaq} className={clsx('p-4 rounded-lg border text-left relative focus-ring', hasPrfaq ? 'bg-ok-subtle border-ok/30' : 'bg-card border-border')}>
                {hasPrfaq ? <Check size={14} aria-hidden="true" className="absolute top-2 right-2 text-ok" /> : null}
                <div className="font-medium">{t('wizards.prfaqLabel', { defaultValue: 'PR-FAQ' })}</div>
                <div className="text-sm text-muted">{t('wizards.prfaqDesc', { defaultValue: 'Amazon-style Press Release & FAQ' })}</div>
              </button>
              <button type="button" onClick={() => toggleDocType('prd')} aria-pressed={hasPrd} className={clsx('p-4 rounded-lg border text-left relative focus-ring', hasPrd ? 'bg-accent-subtle border-accent/40' : 'bg-card border-border')}>
                {hasPrd ? <Check size={14} aria-hidden="true" className="absolute top-2 right-2 text-accent-text" /> : null}
                <div className="font-medium">{t('wizards.prdLabel', { defaultValue: 'PRD' })}</div>
                <div className="text-sm text-muted">{t('wizards.prdDesc', { defaultValue: 'Product Requirements Document' })}</div>
              </button>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium">{t('wizards.featureTitle', { defaultValue: 'Feature/Product Title' })}</h3>
              <button
                type="button"
                onClick={onSuggestBrief}
                disabled={briefing}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-accent-text bg-accent-subtle hover:bg-accent/20 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('wizards.briefTitle', { defaultValue: 'Let AI draft the title and description from this project’s feedback' })}
              >
                {briefing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {briefing
                  ? t('wizards.briefLoading', { defaultValue: 'Drafting…' })
                  : t('wizards.briefButton', { defaultValue: 'AI draft' })}
              </button>
            </div>
            <input type="text" value={docConfig.title} onChange={(e) => onDocConfigChange({
              ...docConfig,
              title: e.target.value,
            })} placeholder={t('wizards.featureTitlePlaceholder', { defaultValue: 'e.g., Real-time Delivery Tracking' })} className="input" />
            {briefError ? <p className="text-xs text-danger mt-1">{briefError}</p> : null}
          </div>
          <div>
            <h3 className="font-medium mb-3">{t('wizards.featureDescription', { defaultValue: 'Feature Description' })}</h3>
            <textarea value={docConfig.featureIdea} onChange={(e) => onDocConfigChange({
              ...docConfig,
              featureIdea: e.target.value,
            })} placeholder={t('wizards.featureDescriptionPlaceholder', { defaultValue: 'Describe the feature...' })} rows={3} className="input" />
          </div>
          {hasPrfaq && (
            <div className="border-t pt-6">
              <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{t('wizards.amazonQuestions')}</h3>
                  <span className="text-xs bg-ok-subtle text-ok px-2 py-0.5 rounded-sm">{t('wizards.workingBackwards', { defaultValue: 'Working Backwards' })}</span>
                </div>
                <button
                  onClick={onAutofill}
                  disabled={autofilling}
                  className="btn btn-primary btn-sm"
                  title={t('wizards.autofillTitle', { defaultValue: 'Pre-populate the 5 questions using personas, feedback, and product context' })}
                >
                  {autofilling ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {autofilling
                    ? t('wizards.autofillLoading', { defaultValue: 'Drafting…' })
                    : t('wizards.autofillButton', { defaultValue: 'AI draft answers' })}
                </button>
              </div>
              <p className="text-sm text-muted mb-4">{t('wizards.amazonQuestionsHint')}</p>
              {autofillError ? (
                <p className="text-xs text-danger mb-3 flex items-center gap-1.5"><AlertTriangle size={12} aria-hidden="true" />{autofillError}</p>
              ) : null}
              <div className="space-y-4">
                {amazonQuestions.map((q, index) => (
                  <div key={q.title} className="bg-bg-accent rounded-lg p-4">
                    <div className="flex items-start gap-2 mb-2">
                      <span className="flex-shrink-0 w-6 h-6 bg-ok text-ok-fg rounded-full font-mono flex items-center justify-center text-xs font-medium">
                        {index + 1}
                      </span>
                      <div className="flex-1">
                        <h4 className="font-medium text-text-strong">{q.title}</h4>
                        <p className="text-xs text-muted mt-0.5">{q.description}</p>
                      </div>
                    </div>
                    <textarea
                      value={docConfig.customerQuestions[index] ?? ''}
                      onChange={(e) => updateQuestion(index, e.target.value)}
                      placeholder={q.placeholder}
                      rows={3}
                      className="input mt-2"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
        </div>
      )}
      finalStepValid={docConfig.title.trim() !== '' && docConfig.featureIdea.trim() !== '' && docCount > 0}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'doc'}
      submitLabel={<><FileText size={16} />{submitLabelText}</>}
    />
  )
}
