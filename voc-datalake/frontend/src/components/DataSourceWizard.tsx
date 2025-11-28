import { useState, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight, Loader2, FileText } from 'lucide-react'
import type { ProjectPersona, ProjectDocument } from '../api/client'
import { api } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { SOURCES as DEFAULT_SOURCES, CATEGORIES, SENTIMENTS } from '../constants/filters'
import clsx from 'clsx'

// Shared context configuration
export interface ContextConfig {
  // Data source toggles
  useFeedback: boolean
  usePersonas: boolean
  useDocuments: boolean
  useResearch: boolean
  // Feedback filters
  sources: string[]
  categories: string[]
  sentiments: string[]
  days: number
  // Selected items
  selectedPersonaIds: string[]
  selectedDocumentIds: string[]
  selectedResearchIds: string[]
}

export const defaultContextConfig: ContextConfig = {
  useFeedback: true,
  usePersonas: false,
  useDocuments: false,
  useResearch: false,
  sources: [],
  categories: [],
  sentiments: [],
  days: 30,
  selectedPersonaIds: [],
  selectedDocumentIds: [],
  selectedResearchIds: [],
}

interface DataSourceWizardProps {
  // Wizard config
  title: string
  accentColor: 'purple' | 'amber' | 'blue' | 'green'
  icon: React.ReactNode
  // Data
  personas: ProjectPersona[]
  documents: ProjectDocument[]
  // Context state
  contextConfig: ContextConfig
  onContextChange: (config: ContextConfig) => void
  // Tool-specific final step
  renderFinalStep: () => React.ReactNode
  finalStepValid: boolean
  // Actions
  onClose: () => void
  onSubmit: () => void
  isSubmitting: boolean
  submitLabel: React.ReactNode
  // Optional: hide certain data source options
  hideDataSources?: ('feedback' | 'personas' | 'documents' | 'research')[]
}

export default function DataSourceWizard({
  title,
  accentColor,
  icon,
  personas,
  documents,
  contextConfig,
  onContextChange,
  renderFinalStep,
  finalStepValid,
  onClose,
  onSubmit,
  isSubmitting,
  submitLabel,
  hideDataSources = [],
}: DataSourceWizardProps) {
  const [step, setStep] = useState(1)
  const [sources, setSources] = useState<string[]>(DEFAULT_SOURCES)
  const { config } = useConfigStore()

  // Fetch actual sources from API
  useEffect(() => {
    if (!config.apiEndpoint) return
    
    api.getSources(30).then(data => {
      if (data.sources && Object.keys(data.sources).length > 0) {
        // Merge API sources with defaults, sorted by count
        const apiSources = Object.keys(data.sources).sort((a, b) => data.sources[b] - data.sources[a])
        setSources(apiSources)
      }
    }).catch(() => {
      // Keep default sources on error
    })
  }, [config.apiEndpoint])

  // Split documents into research and other
  const researchDocs = documents.filter(d => d.document_type === 'research')
  const otherDocs = documents.filter(d => d.document_type !== 'research')

  // Calculate total steps dynamically
  const needsFeedbackFilters = contextConfig.useFeedback
  const needsItemSelection = 
    (contextConfig.usePersonas && personas.length > 0) || 
    (contextConfig.useDocuments && otherDocs.length > 0) ||
    (contextConfig.useResearch && researchDocs.length > 0)
  
  const totalSteps = 1 + (needsFeedbackFilters ? 1 : 0) + (needsItemSelection ? 1 : 0) + 1 // data sources + filters? + selection? + final

  // Map current step to content
  const getStepContent = () => {
    let currentStep = 1
    
    // Step 1: Data Sources (always)
    if (step === currentStep) return 'dataSources'
    currentStep++
    
    // Step 2: Feedback Filters (if feedback selected)
    if (needsFeedbackFilters) {
      if (step === currentStep) return 'feedbackFilters'
      currentStep++
    }
    
    // Step 3: Item Selection (if personas/documents/research selected)
    if (needsItemSelection) {
      if (step === currentStep) return 'itemSelection'
      currentStep++
    }
    
    // Final Step: Tool-specific
    return 'final'
  }

  const stepContent = getStepContent()
  
  // Check which data sources to show
  const showFeedback = !hideDataSources.includes('feedback')
  const showPersonas = !hideDataSources.includes('personas') && personas.length > 0
  const showDocuments = !hideDataSources.includes('documents') && otherDocs.length > 0
  const showResearch = !hideDataSources.includes('research') && researchDocs.length > 0

  const colorClasses = {
    purple: { bg: 'bg-purple-600', bgLight: 'bg-purple-100', border: 'border-purple-300', text: 'text-purple-700', hover: 'hover:bg-purple-700' },
    amber: { bg: 'bg-amber-600', bgLight: 'bg-amber-100', border: 'border-amber-300', text: 'text-amber-700', hover: 'hover:bg-amber-700' },
    blue: { bg: 'bg-blue-600', bgLight: 'bg-blue-100', border: 'border-blue-300', text: 'text-blue-700', hover: 'hover:bg-blue-700' },
    green: { bg: 'bg-green-600', bgLight: 'bg-green-100', border: 'border-green-300', text: 'text-green-700', hover: 'hover:bg-green-700' },
  }
  const colors = colorClasses[accentColor]

  const toggleArrayItem = (arr: string[], item: string) =>
    arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            {icon}
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-sm text-gray-500">Step {step} of {totalSteps}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-gray-100">
          <div className={clsx('h-full transition-all', colors.bg)} style={{ width: `${(step / totalSteps) * 100}%` }} />
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {/* Step: Data Sources */}
          {stepContent === 'dataSources' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-medium mb-3">Data Sources</h3>
                <p className="text-sm text-gray-500 mb-4">Select what data to use for generating the document</p>
                <div className="space-y-2">
                  {showFeedback && (
                    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={contextConfig.useFeedback}
                        onChange={e => onContextChange({ ...contextConfig, useFeedback: e.target.checked })}
                        className="w-4 h-4"
                      />
                      <div>
                        <div className="font-medium">Customer Feedback</div>
                        <div className="text-sm text-gray-500">Use feedback from selected sources</div>
                      </div>
                    </label>
                  )}
                  
                  {showPersonas && (
                    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={contextConfig.usePersonas}
                        onChange={e => onContextChange({ ...contextConfig, usePersonas: e.target.checked, selectedPersonaIds: e.target.checked ? contextConfig.selectedPersonaIds : [] })}
                        className="w-4 h-4"
                      />
                      <div>
                        <div className="font-medium">Personas ({personas.length})</div>
                        <div className="text-sm text-gray-500">Include user personas for context</div>
                      </div>
                    </label>
                  )}
                  
                  {showDocuments && (
                    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={contextConfig.useDocuments}
                        onChange={e => onContextChange({ ...contextConfig, useDocuments: e.target.checked, selectedDocumentIds: e.target.checked ? contextConfig.selectedDocumentIds : [] })}
                        className="w-4 h-4"
                      />
                      <div>
                        <div className="font-medium">Existing Documents ({otherDocs.length})</div>
                        <div className="text-sm text-gray-500">Reference existing PRDs, PR-FAQs, etc.</div>
                      </div>
                    </label>
                  )}
                  
                  {showResearch && (
                    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={contextConfig.useResearch}
                        onChange={e => onContextChange({ ...contextConfig, useResearch: e.target.checked, selectedResearchIds: e.target.checked ? contextConfig.selectedResearchIds : [] })}
                        className="w-4 h-4"
                      />
                      <div>
                        <div className="font-medium">Research Documents ({researchDocs.length})</div>
                        <div className="text-sm text-gray-500">Include research findings</div>
                      </div>
                    </label>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step: Feedback Filters */}
          {stepContent === 'feedbackFilters' && (
            <div className="space-y-6">
              <div>
                <h3 className="font-medium mb-3">Sources</h3>
                <p className="text-sm text-gray-500 mb-2">Leave empty for all sources</p>
                <div className="grid grid-cols-3 gap-2">
                  {sources.map(s => (
                    <button
                      key={s}
                      onClick={() => onContextChange({ ...contextConfig, sources: toggleArrayItem(contextConfig.sources, s) })}
                      className={clsx(
                        'px-3 py-2 rounded-lg border text-sm',
                        contextConfig.sources.includes(s) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-white border-gray-200'
                      )}
                    >
                      {s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-medium mb-3">Categories</h3>
                <div className="grid grid-cols-3 gap-2">
                  {CATEGORIES.map(c => (
                    <button
                      key={c}
                      onClick={() => onContextChange({ ...contextConfig, categories: toggleArrayItem(contextConfig.categories, c) })}
                      className={clsx(
                        'px-3 py-2 rounded-lg border text-sm capitalize',
                        contextConfig.categories.includes(c) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-white border-gray-200'
                      )}
                    >
                      {c.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-medium mb-3">Sentiments</h3>
                <div className="flex gap-2">
                  {SENTIMENTS.map(s => (
                    <button
                      key={s}
                      onClick={() => onContextChange({ ...contextConfig, sentiments: toggleArrayItem(contextConfig.sentiments, s) })}
                      className={clsx(
                        'px-4 py-2 rounded-lg border text-sm flex-1 capitalize',
                        contextConfig.sentiments.includes(s)
                          ? s === 'positive' ? 'bg-green-100 border-green-300 text-green-700'
                          : s === 'negative' ? 'bg-red-100 border-red-300 text-red-700'
                          : `${colors.bgLight} ${colors.border} ${colors.text}`
                          : 'bg-white border-gray-200'
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-medium mb-3">Time Range</h3>
                <select
                  value={contextConfig.days}
                  onChange={e => onContextChange({ ...contextConfig, days: +e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value={7}>Last 7 days</option>
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={60}>Last 60 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </div>
            </div>
          )}

          {/* Step: Item Selection */}
          {stepContent === 'itemSelection' && (
            <div className="space-y-6">
              {contextConfig.usePersonas && personas.length > 0 && (
                <div>
                  <h3 className="font-medium mb-3">Select Personas</h3>
                  <p className="text-sm text-gray-500 mb-3">Leave empty to use all personas</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {personas.map(p => (
                      <label key={p.persona_id} className="flex items-center gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={contextConfig.selectedPersonaIds.includes(p.persona_id)}
                          onChange={e => onContextChange({
                            ...contextConfig,
                            selectedPersonaIds: e.target.checked
                              ? [...contextConfig.selectedPersonaIds, p.persona_id]
                              : contextConfig.selectedPersonaIds.filter(id => id !== p.persona_id)
                          })}
                          className="w-4 h-4"
                        />
                        <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
                          {p.name.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{p.name}</div>
                          <div className="text-xs text-gray-500 truncate">{p.tagline}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {contextConfig.useDocuments && otherDocs.length > 0 && (
                <div>
                  <h3 className="font-medium mb-3">Select Documents</h3>
                  <p className="text-sm text-gray-500 mb-3">Leave empty to use all documents</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {otherDocs.map(d => (
                      <label key={d.document_id} className="flex items-center gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={contextConfig.selectedDocumentIds.includes(d.document_id)}
                          onChange={e => onContextChange({
                            ...contextConfig,
                            selectedDocumentIds: e.target.checked
                              ? [...contextConfig.selectedDocumentIds, d.document_id]
                              : contextConfig.selectedDocumentIds.filter(id => id !== d.document_id)
                          })}
                          className="w-4 h-4"
                        />
                        <div className={clsx(
                          'w-8 h-8 rounded-lg flex items-center justify-center',
                          d.document_type === 'prd' ? 'bg-blue-100' : d.document_type === 'prfaq' ? 'bg-green-100' : 'bg-purple-100'
                        )}>
                          <FileText size={16} className={clsx(
                            d.document_type === 'prd' ? 'text-blue-600' : d.document_type === 'prfaq' ? 'text-green-600' : 'text-purple-600'
                          )} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{d.title}</div>
                          <div className="text-xs text-gray-500">{d.document_type.toUpperCase()}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {contextConfig.useResearch && researchDocs.length > 0 && (
                <div>
                  <h3 className="font-medium mb-3">Select Research Documents</h3>
                  <p className="text-sm text-gray-500 mb-3">Leave empty to use all research</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {researchDocs.map(d => (
                      <label key={d.document_id} className="flex items-center gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={contextConfig.selectedResearchIds.includes(d.document_id)}
                          onChange={e => onContextChange({
                            ...contextConfig,
                            selectedResearchIds: e.target.checked
                              ? [...contextConfig.selectedResearchIds, d.document_id]
                              : contextConfig.selectedResearchIds.filter(id => id !== d.document_id)
                          })}
                          className="w-4 h-4"
                        />
                        <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center">
                          <FileText size={16} className="text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{d.title}</div>
                          <div className="text-xs text-gray-500">RESEARCH</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Final Step: Tool-specific */}
          {stepContent === 'final' && renderFinalStep()}
        </div>

        {/* Footer */}
        <div className="flex justify-between p-4 border-t bg-gray-50">
          <button
            onClick={() => setStep(s => Math.max(1, s - 1))}
            disabled={step === 1}
            className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50"
          >
            <ChevronLeft size={16} />Back
          </button>
          
          {step < totalSteps ? (
            <button
              onClick={() => setStep(s => s + 1)}
              className={clsx('flex items-center gap-2 px-4 py-2 text-white rounded-lg', colors.bg, colors.hover)}
            >
              Next<ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={onSubmit}
              disabled={!finalStepValid || isSubmitting}
              className={clsx('flex items-center gap-2 px-6 py-2 text-white rounded-lg disabled:opacity-50', colors.bg, colors.hover)}
            >
              {isSubmitting ? (
                <><Loader2 size={16} className="animate-spin" />Processing...</>
              ) : (
                submitLabel
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Summary component for final steps
export function ContextSummary({ config, personas, documents }: {
  config: ContextConfig
  personas: ProjectPersona[]
  documents: ProjectDocument[]
}) {
  const selectedPersonas = personas.filter(p => config.selectedPersonaIds.includes(p.persona_id))
  const researchDocs = documents.filter(d => d.document_type === 'research')
  const otherDocs = documents.filter(d => d.document_type !== 'research')
  const selectedDocs = otherDocs.filter(d => config.selectedDocumentIds.includes(d.document_id))
  const selectedResearch = researchDocs.filter(d => config.selectedResearchIds.includes(d.document_id))

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
      <h4 className="font-medium">Context Summary</h4>
      
      {config.useFeedback && (
        <div className="space-y-1">
          <p><span className="text-gray-500">Sources:</span> {config.sources.length ? config.sources.join(', ') : 'All'}</p>
          <p><span className="text-gray-500">Categories:</span> {config.categories.length ? config.categories.join(', ') : 'All'}</p>
          <p><span className="text-gray-500">Sentiments:</span> {config.sentiments.length ? config.sentiments.join(', ') : 'All'}</p>
          <p><span className="text-gray-500">Time Range:</span> Last {config.days} days</p>
        </div>
      )}
      
      {config.usePersonas && (
        <p><span className="text-gray-500">Personas:</span> {
          selectedPersonas.length ? selectedPersonas.map(p => p.name).join(', ') : `All ${personas.length} personas`
        }</p>
      )}
      
      {config.useDocuments && (
        <p><span className="text-gray-500">Documents:</span> {
          selectedDocs.length ? selectedDocs.map(d => d.title).join(', ') : `All ${otherDocs.length} documents`
        }</p>
      )}
      
      {config.useResearch && (
        <p><span className="text-gray-500">Research:</span> {
          selectedResearch.length ? selectedResearch.map(d => d.title).join(', ') : `All ${researchDocs.length} research docs`
        }</p>
      )}
      
      {!config.useFeedback && !config.usePersonas && !config.useDocuments && !config.useResearch && (
        <p className="text-gray-400 italic">No data sources selected</p>
      )}
    </div>
  )
}
