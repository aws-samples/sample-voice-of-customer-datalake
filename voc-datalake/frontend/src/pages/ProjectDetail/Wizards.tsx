/**
 * Wizard components for ProjectDetail page
 */
import clsx from 'clsx'
import {
  Users, FileText, Search, Shuffle, Sparkles, Loader2, Wand2,
} from 'lucide-react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import DataSourceWizard from '../../components/DataSourceWizard'
import ContextSummary from '../../components/DataSourceWizard/ContextSummary'
import type {
  PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig,
} from './types'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'

interface PersonaWizardProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly personaConfig: PersonaToolConfig
  readonly generating: string | null
  readonly onContextChange: (c: ContextConfig) => void
  readonly onPersonaConfigChange: (c: PersonaToolConfig) => void
  readonly onClose: () => void
  readonly onSubmit: () => void
}

export function PersonaWizard({
  personas, documents, contextConfig, personaConfig, generating, onContextChange, onPersonaConfigChange, onClose, onSubmit,
}: PersonaWizardProps) {
  return (
    <DataSourceWizard
      title="Generate Personas"
      accentColor="purple"
      icon={<div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center"><Users size={20} className="text-purple-600" /></div>}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-3">Number of Personas: {personaConfig.personaCount}</h3>
            <input type="range" min={1} max={7} value={personaConfig.personaCount} onChange={(e) => onPersonaConfigChange({
              ...personaConfig,
              personaCount: +e.target.value,
            })} className="w-full" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Custom Instructions (Optional)</h3>
            <textarea value={personaConfig.customInstructions} onChange={(e) => onPersonaConfigChange({
              ...personaConfig,
              customInstructions: e.target.value,
            })} placeholder="e.g., Focus on business travelers..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
        </div>
      )}
      finalStepValid
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'personas'}
      submitLabel={<><Sparkles size={16} />Generate Personas</>}
    />
  )
}

interface ResearchWizardProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly researchConfig: ResearchToolConfig
  readonly generating: string | null
  readonly onContextChange: (c: ContextConfig) => void
  readonly onResearchConfigChange: (c: ResearchToolConfig) => void
  readonly onClose: () => void
  readonly onSubmit: () => void
}

export function ResearchWizard({
  projectId, personas, documents, contextConfig, researchConfig, generating, onContextChange, onResearchConfigChange, onClose, onSubmit,
}: ResearchWizardProps) {
  const { t, i18n } = useTranslation('projectDetail')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Array<{ title: string; question: string }>>([])

  const onSuggest = useCallback(async () => {
    setSuggesting(true)
    setSuggestError(null)
    try {
      const r = await projectsApi.suggestResearchQuestions(projectId, { response_language: i18n.language })
      const list = r.suggestions ?? []
      setSuggestions(list)
      if (list.length === 0) {
        setSuggestError(t('wizards.researchSuggestEmpty', { defaultValue: 'No suggestions — add or collect more feedback first.' }))
      }
    } catch (e: unknown) {
      setSuggestError(e instanceof Error ? e.message : 'Failed to suggest questions')
    } finally {
      setSuggesting(false)
    }
  }, [projectId, i18n.language, t])

  const applySuggestion = useCallback((s: { title: string; question: string }) => {
    onResearchConfigChange({
      ...researchConfig,
      question: s.question,
      title: researchConfig.title.trim() === '' ? s.title : researchConfig.title,
    })
  }, [researchConfig, onResearchConfigChange])

  return (
    <DataSourceWizard
      title="Run Research"
      accentColor="amber"
      icon={<div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center"><Search size={20} className="text-amber-600" /></div>}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium">Research Question</h3>
              <button
                type="button"
                onClick={onSuggest}
                disabled={suggesting}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('wizards.researchSuggestTitle', { defaultValue: 'Let AI suggest research questions from this project’s feedback' })}
              >
                {suggesting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {suggesting
                  ? t('wizards.researchSuggesting', { defaultValue: 'Suggesting…' })
                  : t('wizards.researchSuggest', { defaultValue: 'AI suggest' })}
              </button>
            </div>
            <textarea value={researchConfig.question} onChange={(e) => onResearchConfigChange({
              ...researchConfig,
              question: e.target.value,
            })} placeholder="e.g., What are the main pain points..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
            {suggestError ? <p className="text-xs text-red-600 mt-1">{suggestError}</p> : null}
            {suggestions.length > 0 ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-gray-500">{t('wizards.researchSuggestPick', { defaultValue: 'Tap a suggestion to use it:' })}</p>
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => applySuggestion(s)}
                    className="block w-full text-left p-2.5 border rounded-lg hover:border-amber-400 hover:bg-amber-50 transition-colors"
                  >
                    <span className="block text-sm font-medium text-gray-800">{s.title || s.question}</span>
                    {s.title ? <span className="block text-xs text-gray-500 mt-0.5">{s.question}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div>
            <h3 className="font-medium mb-3">Research Title</h3>
            <input type="text" value={researchConfig.title} onChange={(e) => onResearchConfigChange({
              ...researchConfig,
              title: e.target.value,
            })} placeholder="e.g., Delivery Pain Points Analysis" className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
        </div>
      )}
      finalStepValid={researchConfig.question.trim() !== ''}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'research'}
      submitLabel={<><Search size={16} />Run Research</>}
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
  const { t, i18n } = useTranslation('projectDetail')
  const [autofilling, setAutofilling] = useState(false)
  const [autofillError, setAutofillError] = useState<string | null>(null)
  const [briefing, setBriefing] = useState(false)
  const [briefError, setBriefError] = useState<string | null>(null)

  const docTypes = docConfig.docTypes
  const hasPrfaq = docTypes.includes('prfaq')
  const hasPrd = docTypes.includes('prd')

  const toggleDocType = (type: 'prd' | 'prfaq') => {
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
      const answers = (r.answers || []).slice(0, 5)
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

  return (
    <DataSourceWizard
      title={bothSelected
        ? t('wizards.generateBothTitle', { defaultValue: 'Generate PRD + PR-FAQ' })
        : t(hasPrd ? 'wizards.generatePrdTitle' : 'wizards.generatePrfaqTitle', { defaultValue: hasPrd ? 'Generate PRD' : 'Generate PR-FAQ' })}
      accentColor="blue"
      icon={<div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center"><FileText size={20} className="text-blue-600" /></div>}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-1">{t('wizards.documentType', { defaultValue: 'Document Type' })}</h3>
            <p className="text-xs text-gray-500 mb-3">{t('wizards.documentTypeHint', { defaultValue: 'Select one or both — both are generated at once.' })}</p>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => toggleDocType('prfaq')} className={clsx('p-4 rounded-lg border text-left relative', hasPrfaq ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200')}>
                {hasPrfaq ? <span className="absolute top-2 right-2 text-green-600 text-xs">✓</span> : null}
                <div className="font-medium">{t('wizards.prfaqLabel', { defaultValue: 'PR-FAQ' })}</div>
                <div className="text-sm text-gray-500">{t('wizards.prfaqDesc', { defaultValue: 'Amazon-style Press Release & FAQ' })}</div>
              </button>
              <button type="button" onClick={() => toggleDocType('prd')} className={clsx('p-4 rounded-lg border text-left relative', hasPrd ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200')}>
                {hasPrd ? <span className="absolute top-2 right-2 text-blue-600 text-xs">✓</span> : null}
                <div className="font-medium">{t('wizards.prdLabel', { defaultValue: 'PRD' })}</div>
                <div className="text-sm text-gray-500">{t('wizards.prdDesc', { defaultValue: 'Product Requirements Document' })}</div>
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
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
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
            })} placeholder={t('wizards.featureTitlePlaceholder', { defaultValue: 'e.g., Real-time Delivery Tracking' })} className="w-full px-3 py-2 border rounded-lg" />
            {briefError ? <p className="text-xs text-red-600 mt-1">{briefError}</p> : null}
          </div>
          <div>
            <h3 className="font-medium mb-3">{t('wizards.featureDescription', { defaultValue: 'Feature Description' })}</h3>
            <textarea value={docConfig.featureIdea} onChange={(e) => onDocConfigChange({
              ...docConfig,
              featureIdea: e.target.value,
            })} placeholder={t('wizards.featureDescriptionPlaceholder', { defaultValue: 'Describe the feature...' })} rows={3} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          {hasPrfaq && (
            <div className="border-t pt-6">
              <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{t('wizards.amazonQuestions')}</h3>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">{t('wizards.workingBackwards', { defaultValue: 'Working Backwards' })}</span>
                </div>
                <button
                  onClick={onAutofill}
                  disabled={autofilling}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-md text-xs disabled:opacity-50"
                  title={t('wizards.autofillTitle', { defaultValue: 'Pre-populate the 5 questions using personas, feedback, and product context' })}
                >
                  {autofilling ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {autofilling
                    ? t('wizards.autofillLoading', { defaultValue: 'Drafting…' })
                    : t('wizards.autofillButton', { defaultValue: 'AI draft answers' })}
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-4">{t('wizards.amazonQuestionsHint')}</p>
              {autofillError ? (
                <p className="text-xs text-red-600 mb-3">⚠ {autofillError}</p>
              ) : null}
              <div className="space-y-4">
                {amazonQuestions.map((q, index) => (
                  <div key={q.title} className="bg-gray-50 rounded-lg p-4">
                    <div className="flex items-start gap-2 mb-2">
                      <span className="flex-shrink-0 w-6 h-6 bg-green-600 text-white rounded-full flex items-center justify-center text-xs font-medium">
                        {index + 1}
                      </span>
                      <div className="flex-1">
                        <h4 className="font-medium text-gray-900">{q.title}</h4>
                        <p className="text-xs text-gray-500 mt-0.5">{q.description}</p>
                      </div>
                    </div>
                    <textarea
                      value={docConfig.customerQuestions[index] ?? ''}
                      onChange={(e) => updateQuestion(index, e.target.value)}
                      placeholder={q.placeholder}
                      rows={3}
                      className="w-full px-3 py-2 border rounded-lg text-sm mt-2"
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
      submitLabel={<><FileText size={16} />{bothSelected
        ? t('wizards.generateBoth', { defaultValue: 'Generate PRD + PR-FAQ' })
        : t(hasPrd ? 'wizards.generatePrd' : 'wizards.generatePrfaq', { defaultValue: hasPrd ? 'Generate PRD' : 'Generate PR-FAQ' })}</>}
    />
  )
}

interface MergeWizardProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly mergeConfig: MergeToolConfig
  readonly generating: string | null
  readonly onContextChange: (c: ContextConfig) => void
  readonly onMergeConfigChange: (c: MergeToolConfig) => void
  readonly onClose: () => void
  readonly onSubmit: () => void
}

export function MergeWizard({
  personas, documents, contextConfig, mergeConfig, generating, onContextChange, onMergeConfigChange, onClose, onSubmit,
}: MergeWizardProps) {
  const totalDocs = contextConfig.selectedDocumentIds.length + contextConfig.selectedResearchIds.length
  return (
    <DataSourceWizard
      title="Remix Documents"
      accentColor="green"
      icon={<div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center"><Shuffle size={20} className="text-green-600" /></div>}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      hideDataSources={['feedback']}
      combineDocuments
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-3">Output Document Type</h3>
            <div className="grid grid-cols-3 gap-3">
              {(['prfaq', 'prd', 'custom'] as const).map((type) => (
                <button key={type} onClick={() => onMergeConfigChange({
                  ...mergeConfig,
                  outputType: type,
                })} className={clsx('p-4 rounded-lg border text-left', mergeConfig.outputType === type ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200')}>
                  <div className="font-medium">{type.toUpperCase()}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-medium mb-3">New Document Title</h3>
            <input type="text" value={mergeConfig.title} onChange={(e) => onMergeConfigChange({
              ...mergeConfig,
              title: e.target.value,
            })} placeholder="e.g., Virtual Concierge PRD v2" className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Remix Instructions</h3>
            <textarea value={mergeConfig.instructions} onChange={(e) => onMergeConfigChange({
              ...mergeConfig,
              instructions: e.target.value,
            })} placeholder="Describe how to remix..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
          {totalDocs < 2 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
              ⚠️ Select at least 2 documents to remix.
            </div>
          )}
        </div>
      )}
      finalStepValid={mergeConfig.title.trim() !== '' && mergeConfig.instructions.trim() !== '' && totalDocs >= 2}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'merge'}
      submitLabel={<><Shuffle size={16} />Remix Documents</>}
    />
  )
}
