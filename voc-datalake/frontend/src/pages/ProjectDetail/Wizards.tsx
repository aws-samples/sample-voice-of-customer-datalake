/**
 * Wizard components for ProjectDetail page
 */
import { Users, FileText, Search, Shuffle, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import DataSourceWizard from '../../components/DataSourceWizard'
import ContextSummary from '../../components/DataSourceWizard/ContextSummary'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'
import type { PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig } from './types'

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

export function PersonaWizard({ personas, documents, contextConfig, personaConfig, generating, onContextChange, onPersonaConfigChange, onClose, onSubmit }: PersonaWizardProps) {
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
            <input type="range" min={1} max={7} value={personaConfig.personaCount} onChange={e => onPersonaConfigChange({ ...personaConfig, personaCount: +e.target.value })} className="w-full" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Custom Instructions (Optional)</h3>
            <textarea value={personaConfig.customInstructions} onChange={e => onPersonaConfigChange({ ...personaConfig, customInstructions: e.target.value })} placeholder="e.g., Focus on business travelers..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
        </div>
      )}
      finalStepValid={true}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'personas'}
      submitLabel={<><Sparkles size={16} />Generate Personas</>}
    />
  )
}

interface ResearchWizardProps {
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

export function ResearchWizard({ personas, documents, contextConfig, researchConfig, generating, onContextChange, onResearchConfigChange, onClose, onSubmit }: ResearchWizardProps) {
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
            <h3 className="font-medium mb-3">Research Title</h3>
            <input type="text" value={researchConfig.title} onChange={e => onResearchConfigChange({ ...researchConfig, title: e.target.value })} placeholder="e.g., Delivery Pain Points Analysis" className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Research Question</h3>
            <textarea value={researchConfig.question} onChange={e => onResearchConfigChange({ ...researchConfig, question: e.target.value })} placeholder="e.g., What are the main pain points..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
        </div>
      )}
      finalStepValid={!!researchConfig.question.trim()}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'research'}
      submitLabel={<><Search size={16} />Run Research</>}
    />
  )
}

interface DocWizardProps {
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

export function DocWizard({ personas, documents, contextConfig, docConfig, generating, onContextChange, onDocConfigChange, onClose, onSubmit }: DocWizardProps) {
  return (
    <DataSourceWizard
      title={`Generate ${docConfig.docType === 'prd' ? 'PRD' : 'PR-FAQ'}`}
      accentColor="blue"
      icon={<div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center"><FileText size={20} className="text-blue-600" /></div>}
      personas={personas}
      documents={documents}
      contextConfig={contextConfig}
      onContextChange={onContextChange}
      renderFinalStep={() => (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-3">Document Type</h3>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => onDocConfigChange({ ...docConfig, docType: 'prd' })} className={clsx('p-4 rounded-lg border text-left', docConfig.docType === 'prd' ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200')}>
                <div className="font-medium">PRD</div>
                <div className="text-sm text-gray-500">Product Requirements Document</div>
              </button>
              <button onClick={() => onDocConfigChange({ ...docConfig, docType: 'prfaq' })} className={clsx('p-4 rounded-lg border text-left', docConfig.docType === 'prfaq' ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200')}>
                <div className="font-medium">PR-FAQ</div>
                <div className="text-sm text-gray-500">Amazon-style Press Release & FAQ</div>
              </button>
            </div>
          </div>
          <div>
            <h3 className="font-medium mb-3">Feature/Product Title</h3>
            <input type="text" value={docConfig.title} onChange={e => onDocConfigChange({ ...docConfig, title: e.target.value })} placeholder="e.g., Real-time Delivery Tracking" className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Feature Description</h3>
            <textarea value={docConfig.featureIdea} onChange={e => onDocConfigChange({ ...docConfig, featureIdea: e.target.value })} placeholder="Describe the feature..." rows={3} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
        </div>
      )}
      finalStepValid={!!docConfig.title.trim() && !!docConfig.featureIdea.trim()}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'doc'}
      submitLabel={<><FileText size={16} />Generate {docConfig.docType === 'prd' ? 'PRD' : 'PR-FAQ'}</>}
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

export function MergeWizard({ personas, documents, contextConfig, mergeConfig, generating, onContextChange, onMergeConfigChange, onClose, onSubmit }: MergeWizardProps) {
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
              {(['prfaq', 'prd', 'custom'] as const).map(type => (
                <button key={type} onClick={() => onMergeConfigChange({ ...mergeConfig, outputType: type })} className={clsx('p-4 rounded-lg border text-left', mergeConfig.outputType === type ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200')}>
                  <div className="font-medium">{type.toUpperCase()}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-medium mb-3">New Document Title</h3>
            <input type="text" value={mergeConfig.title} onChange={e => onMergeConfigChange({ ...mergeConfig, title: e.target.value })} placeholder="e.g., Virtual Concierge PRD v2" className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <h3 className="font-medium mb-3">Remix Instructions</h3>
            <textarea value={mergeConfig.instructions} onChange={e => onMergeConfigChange({ ...mergeConfig, instructions: e.target.value })} placeholder="Describe how to remix..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <ContextSummary config={contextConfig} personas={personas} documents={documents} />
          {totalDocs < 2 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
              ⚠️ Select at least 2 documents to remix.
            </div>
          )}
        </div>
      )}
      finalStepValid={!!mergeConfig.title.trim() && !!mergeConfig.instructions.trim() && totalDocs >= 2}
      onClose={onClose}
      onSubmit={onSubmit}
      isSubmitting={generating === 'merge'}
      submitLabel={<><Shuffle size={16} />Remix Documents</>}
    />
  )
}
