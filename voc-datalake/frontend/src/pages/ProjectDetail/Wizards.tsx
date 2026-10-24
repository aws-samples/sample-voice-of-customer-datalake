/**
 * Wizard components for ProjectDetail page.
 *
 * Every wizard's icon tile is the brand accent, like the Overview steps: which wizard is
 * open is identity, not a state (labels vs status, rule 15). Until 3.14.02 personas were
 * `aim`, research `warn` and remix `ok`, and the remix wizard's chosen output type was
 * painted `ok` — now the selected recipe `bg-accent-subtle border-accent` (rule 7).
 */

import clsx from 'clsx'
import { Users, Search, Shuffle, Sparkles, Loader2, Wand2, AlertTriangle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { lenientList } from '../../api/lenientFields'
import { projectsApi } from '../../api/projectsApi'
import { serverReason } from '../../lib/errors'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DataSourceWizard from '../../components/DataSourceWizard/DataSourceWizard'
import ContextSummary from '../../components/DataSourceWizard/ContextSummary'
import { documentTypeLabel } from '../../components/DocumentTypeBadge/documentTypes'
import { IconGlyph } from '../../components/SourceIcon/SourceIcon'
import { isWebSearchAvailable } from '../../runtimeConfig'
import type { PersonaToolConfig, ResearchToolConfig, MergeToolConfig } from './types'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ContextConfig } from '../../components/DataSourceWizard/types'
import type { ExtraDataSource } from '../../components/DataSourceWizard/DataSourceSteps'

/** The 40px accent icon tile every project wizard's header opens with. */
export function WizardIconTile({ icon }: Readonly<{ icon: LucideIcon }>) {
  return (
    <div className="w-10 h-10 bg-accent-subtle text-accent-text rounded-lg flex items-center justify-center">
      <IconGlyph icon={icon} size={20} />
    </div>
  )
}

/**
 * The data sources the persona generator cannot read, so the wizard must not
 * offer them. Module-level so it is one array rather than a new one per render.
 */
const PERSONA_HIDDEN_DATA_SOURCES = ['personas', 'documents', 'research'] as const

/**
 * The suggest/autofill responses are not validated in projectsApi, so they are read
 * leniently here: an absent or malformed list is the empty list, one bad item costs itself.
 */
const SuggestionSchema = z.object({ title: z.string(), question: z.string() })
const isSuggestion = (item: unknown): item is z.infer<typeof SuggestionSchema> => SuggestionSchema.safeParse(item).success
const suggestionList = lenientList(isSuggestion)

interface PersonaWizardProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly personaConfig: PersonaToolConfig
  readonly generating: string | null
  /** The start request's failure (e.g. the no-feedback 400), shown on the final step. */
  readonly startError?: unknown
  readonly onContextChange: (c: ContextConfig) => void
  readonly onPersonaConfigChange: (c: PersonaToolConfig) => void
  readonly onClose: () => void
  readonly onSubmit: () => void
}

/**
 * Why the job could not be started: the server's own reason (a 4xx such as "No
 * feedback data found for the given filters", which the user fixes by widening
 * the filters) or a generic retry line. Without it a refused start only stopped
 * the spinner, and the user saw nothing happen.
 */
function WizardStartError({ error }: { readonly error: unknown }) {
  const { t } = useTranslation('projectDetail')
  if (error === null || error === undefined) return null
  return (
    <p role="alert" className="text-sm text-danger inline-flex items-center gap-1.5">
      <AlertTriangle size={14} aria-hidden="true" />
      {serverReason(error) ?? t('wizards.startFailed')}
    </p>
  )
}

interface FinalStepSummaryProps {
  readonly contextConfig: ContextConfig
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly startError: unknown
  readonly children: React.ReactNode
}

/**
 * A job wizard's final step: its own fields, then what will be read, then why the
 * last start failed (if it did).
 */
function FinalStepSummary({ contextConfig, personas, documents, startError, children }: FinalStepSummaryProps) {
  return (
    <div className="space-y-6">
      {children}
      <ContextSummary config={contextConfig} personas={personas} documents={documents} />
      <WizardStartError error={startError} />
    </div>
  )
}

export function PersonaWizard({
  personas, documents, contextConfig, personaConfig, generating, startError, onContextChange, onPersonaConfigChange, onClose, onSubmit,
}: PersonaWizardProps) {
  const { t } = useTranslation('projectDetail')
  // Generating reads the feedback in scope with the AI for minutes: asked first, like PR/FAQ and prototype.
  const [confirming, setConfirming] = useState(false)
  return (
    <>
    <DataSourceWizard
      title={t('wizards.generatePersonas')}
      icon={<WizardIconTile icon={Users} />}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      // Persona generation reads feedback and nothing else: `generatePersonas`
      // sends only feedback filters, persona count and custom instructions. Left
      // on, the shared wizard offered Personas / Documents / Research toggles and
      // item pickers, and ContextSummary reported the selection back — inputs the
      // mutation then dropped. Worse now that Personas comes first in the
      // sequence, since this is exactly where someone would look for "use my
      // research".
      hideDataSources={PERSONA_HIDDEN_DATA_SOURCES}
      renderFinalStep={() => (
        <FinalStepSummary contextConfig={contextConfig} personas={personas} documents={documents} startError={startError}>
          <div>
            <h3 className="font-medium mb-3">Number of Personas: {personaConfig.personaCount}</h3>
            <input type="range" min={1} max={7} value={personaConfig.personaCount} onChange={(e) => onPersonaConfigChange({
              ...personaConfig,
              personaCount: +e.target.value,
            })} className="range" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Custom Instructions (Optional)</h3>
            <textarea value={personaConfig.customInstructions} onChange={(e) => onPersonaConfigChange({
              ...personaConfig,
              customInstructions: e.target.value,
            })} placeholder="e.g., Focus on business travelers..." rows={4} className="input" />
          </div>
        </FinalStepSummary>
      )}
      finalStepValid
      onClose={onClose}
      onSubmit={() => setConfirming(true)}
      isSubmitting={generating === 'personas'}
      submitLabel={<><Sparkles size={16} />{t('wizards.submitGeneratePersonas')}</>}
    />
    <ConfirmModal
      isOpen={confirming}
      variant="info"
      title={t('wizards.personaConfirmTitle')}
      message={t('wizards.personaConfirmMessage', { n: personaConfig.personaCount })}
      confirmLabel={t('wizards.submitGeneratePersonas')}
      onConfirm={() => { setConfirming(false); onSubmit() }}
      onCancel={() => setConfirming(false)}
    />
    </>
  )
}

interface ResearchWizardProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly researchConfig: ResearchToolConfig
  readonly generating: string | null
  /** The start request's failure (e.g. the no-feedback 400), shown on the final step. */
  readonly startError?: unknown
  readonly onContextChange: (c: ContextConfig) => void
  readonly onResearchConfigChange: (c: ResearchToolConfig) => void
  readonly onClose: () => void
  readonly onSubmit: () => void
}

export function ResearchWizard({
  projectId, personas, documents, contextConfig, researchConfig, generating, startError, onContextChange, onResearchConfigChange, onClose, onSubmit,
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
      const list = suggestionList.parse(r.suggestions)
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

  // Web search is a data source, so it lives on the Data Sources step as a
  // peer card of Customer Feedback / Personas (same DataSourceCheckbox
  // formatting). Only offered when the deployment has the AgentCore gateway.
  const extraDataSources: ExtraDataSource[] = isWebSearchAvailable()
    ? [{
        key: 'webSearch',
        checked: researchConfig.useWebSearch,
        title: t('wizards.researchWebSearch', { defaultValue: 'Public Web Search' }),
        description: t('wizards.researchWebSearchHint', { defaultValue: 'AI plans and runs multiple web searches to ground the analysis (served within AWS, sources cited)' }),
        onChange: (checked: boolean) => onResearchConfigChange({
          ...researchConfig,
          useWebSearch: checked,
        }),
      }]
    : []

  return (
    <DataSourceWizard
      title={t('wizards.runResearch')}
      icon={<WizardIconTile icon={Search} />}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      extraDataSources={extraDataSources}
      renderFinalStep={() => (
        <FinalStepSummary contextConfig={contextConfig} personas={personas} documents={documents} startError={startError}>
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium">Research Question</h3>
              <button
                type="button"
                onClick={onSuggest}
                disabled={suggesting}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-accent-text bg-accent-subtle hover:bg-accent/20 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
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
            })} placeholder="e.g., What are the main pain points..." rows={4} className="input" />
            {suggestError ? <p className="text-xs text-danger mt-1">{suggestError}</p> : null}
            {suggestions.length > 0 ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted">{t('wizards.researchSuggestPick', { defaultValue: 'Tap a suggestion to use it:' })}</p>
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => applySuggestion(s)}
                    className="block w-full text-left p-2.5 border border-border rounded-lg hover:bg-bg-hover hover:border-border-strong transition-colors"
                  >
                    <span className="block text-sm font-medium text-text-strong">{s.title || s.question}</span>
                    {s.title ? <span className="block text-xs text-muted mt-0.5">{s.question}</span> : null}
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
            })} placeholder="e.g., Delivery Pain Points Analysis" className="input" />
          </div>
        </FinalStepSummary>
      )}
      finalStepValid={researchConfig.question.trim() !== ''}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'research'}
      submitLabel={<><Search size={16} />Run Research</>}
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
  const { t } = useTranslation('projectDetail')
  const totalDocs = contextConfig.selectedDocumentIds.length + contextConfig.selectedResearchIds.length
  return (
    <DataSourceWizard
      title={t('wizards.remixDocuments')}
      icon={<WizardIconTile icon={Shuffle} />}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      hideDataSources={['feedback']}
      combineDocuments
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-3">{t('wizards.outputDocType')}</h3>
            <div className="grid grid-cols-3 gap-3">
              {(['prfaq', 'prd', 'custom'] as const).map((type) => (
                <button key={type} onClick={() => onMergeConfigChange({
                  ...mergeConfig,
                  outputType: type,
                })} aria-pressed={mergeConfig.outputType === type} className={clsx('p-4 rounded-lg border text-left focus-ring', mergeConfig.outputType === type ? 'bg-accent-subtle border-accent' : 'bg-card border-border')}>
                  <div className="font-medium">{documentTypeLabel(type)}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-medium mb-3">{t('wizards.newDocTitle')}</h3>
            <input type="text" value={mergeConfig.title} onChange={(e) => onMergeConfigChange({
              ...mergeConfig,
              title: e.target.value,
            })} placeholder={t('wizards.newDocTitlePlaceholder')} className="input" />
          </div>
          <div>
            <h3 className="font-medium mb-3">{t('wizards.remixInstructions')}</h3>
            <textarea value={mergeConfig.instructions} onChange={(e) => onMergeConfigChange({
              ...mergeConfig,
              instructions: e.target.value,
            })} placeholder={t('wizards.remixInstructionsPlaceholder')} rows={4} className="input" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
          {totalDocs < 2 && (
            <div className="bg-warn-subtle border border-warn/30 rounded-lg p-3 text-sm text-warn flex items-center gap-2">
              <AlertTriangle size={14} aria-hidden="true" className="flex-shrink-0" />
              {t('wizards.selectAtLeast2')}
            </div>
          )}
        </div>
      )}
      finalStepValid={mergeConfig.title.trim() !== '' && mergeConfig.instructions.trim() !== '' && totalDocs >= 2}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'merge'}
      submitLabel={<><Shuffle size={16} />{t('wizards.submitRemixDocuments')}</>}
    />
  )
}
