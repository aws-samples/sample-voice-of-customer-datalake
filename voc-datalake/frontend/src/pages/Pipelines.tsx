import { useState } from 'react'
// import { useQueryClient } from '@tanstack/react-query'
import {
  Play, Pause, Settings, Plus, Trash2, ChevronRight,
  Code, Sparkles, Filter, ArrowRight, Eye, Save, RefreshCw
} from 'lucide-react'
// import { api } from '../api/client'
import { useConfigStore } from '../store/configStore'
import clsx from 'clsx'
import type { Pipeline, PipelineStep } from '../api/client'

const STEP_TYPES = [
  { type: 'extract', label: 'Extract', icon: Code, color: 'blue', desc: 'Extract raw data from source' },
  { type: 'transform', label: 'Transform', icon: RefreshCw, color: 'purple', desc: 'Normalize and clean data' },
  { type: 'enrich', label: 'AI Enrich', icon: Sparkles, color: 'amber', desc: 'LLM analysis and enrichment' },
  { type: 'filter', label: 'Filter', icon: Filter, color: 'green', desc: 'Filter based on conditions' },
  { type: 'output', label: 'Output', icon: ArrowRight, color: 'gray', desc: 'Store to database' },
]

const SOURCE_ICONS: Record<string, string> = {
  trustpilot: '⭐', google_reviews: '🔍', twitter: '𝕏', instagram: '📷',
  facebook: '📘', reddit: '🔴', tavily: '🌐', appstore_apple: '🍎',
  appstore_google: '▶️', appstore_huawei: '📱',
}


function StepCard({ step, onEdit, onDelete, onToggle }: { 
  step: PipelineStep
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  const stepType = STEP_TYPES.find(t => t.type === step.type)
  const Icon = stepType?.icon || Code

  return (
    <div className={clsx(
      'relative bg-white border-2 rounded-lg p-4 w-full',
      step.enabled ? 'border-gray-200' : 'border-dashed border-gray-300 opacity-60'
    )}>
      <div className="flex items-center justify-between mb-2">
        <div className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center',
          `bg-${stepType?.color || 'gray'}-100 text-${stepType?.color || 'gray'}-600`
        )}>
          <Icon size={16} />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggle} className="p-1 hover:bg-gray-100 rounded" title={step.enabled ? 'Disable' : 'Enable'}>
            {step.enabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button onClick={onEdit} className="p-1 hover:bg-gray-100 rounded" title="Edit">
            <Settings size={14} />
          </button>
          <button onClick={onDelete} className="p-1 hover:bg-gray-100 rounded text-red-500" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <h4 className="font-medium text-sm">{step.name}</h4>
      <p className="text-xs text-gray-500">{stepType?.desc}</p>
      {step.prompt && (
        <div className="mt-2 p-2 bg-gray-50 rounded text-xs text-gray-600 truncate">
          {step.prompt.substring(0, 50)}...
        </div>
      )}
    </div>
  )
}

function StepEditor({ step, onSave, onClose }: {
  step: PipelineStep
  onSave: (step: PipelineStep) => void
  onClose: () => void
}) {
  const [editedStep, setEditedStep] = useState(step)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold">Edit Step: {step.name}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">×</button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto max-h-[60vh]">
          <div>
            <label className="block text-sm font-medium mb-1">Step Name</label>
            <input
              type="text"
              value={editedStep.name}
              onChange={e => setEditedStep({ ...editedStep, name: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Step Type</label>
            <select
              value={editedStep.type}
              onChange={e => setEditedStep({ ...editedStep, type: e.target.value as PipelineStep['type'] })}
              className="input"
            >
              {STEP_TYPES.map(t => (
                <option key={t.type} value={t.type}>{t.label} - {t.desc}</option>
              ))}
            </select>
          </div>

          {editedStep.type === 'enrich' && (
            <div>
              <label className="block text-sm font-medium mb-1">AI Prompt</label>
              <textarea
                value={editedStep.prompt || ''}
                onChange={e => setEditedStep({ ...editedStep, prompt: e.target.value })}
                className="input min-h-[200px] font-mono text-sm"
                placeholder="Enter the prompt for AI analysis..."
              />
              <p className="text-xs text-gray-500 mt-1">
                Variables: {'{text}'}, {'{rating}'}, {'{source}'}, {'{language}'}
              </p>
            </div>
          )}
          {editedStep.type === 'filter' && (
            <div>
              <label className="block text-sm font-medium mb-1">Filter Conditions (JSON)</label>
              <textarea
                value={JSON.stringify(editedStep.config, null, 2)}
                onChange={e => {
                  try {
                    setEditedStep({ ...editedStep, config: JSON.parse(e.target.value) })
                  } catch {}
                }}
                className="input min-h-[150px] font-mono text-sm"
                placeholder='{"min_rating": 1, "languages": ["en", "es"]}'
              />
            </div>
          )}
          {editedStep.type === 'transform' && (
            <div>
              <label className="block text-sm font-medium mb-1">Field Mappings (JSON)</label>
              <textarea
                value={JSON.stringify(editedStep.config, null, 2)}
                onChange={e => {
                  try {
                    setEditedStep({ ...editedStep, config: JSON.parse(e.target.value) })
                  } catch {}
                }}
                className="input min-h-[150px] font-mono text-sm"
                placeholder='{"text_field": "content", "rating_field": "stars"}'
              />
            </div>
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button onClick={() => onSave(editedStep)} className="btn btn-primary flex items-center gap-2">
            <Save size={16} /> Save Step
          </button>
        </div>
      </div>
    </div>
  )
}

function PipelineCard({ pipeline, onSelect, isSelected }: {
  pipeline: Pipeline
  onSelect: () => void
  isSelected: boolean
}) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        'w-full text-left p-4 rounded-lg border-2 transition-all',
        isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
      )}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">{SOURCE_ICONS[pipeline.source] || '📊'}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-medium truncate">{pipeline.name}</h3>
          <p className="text-sm text-gray-500 truncate">{pipeline.description}</p>
        </div>
        <div className={clsx(
          'w-2 h-2 rounded-full',
          pipeline.status === 'running' && 'bg-blue-500 animate-pulse',
          pipeline.status === 'success' && 'bg-green-500',
          pipeline.status === 'error' && 'bg-red-500',
          pipeline.status === 'idle' && 'bg-gray-300'
        )} />
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
        <span>{pipeline.steps.length} steps</span>
        <span>•</span>
        <span>{pipeline.enabled ? 'Active' : 'Disabled'}</span>
        {pipeline.lastRun && (
          <>
            <span>•</span>
            <span>Last: {new Date(pipeline.lastRun).toLocaleDateString()}</span>
          </>
        )}
      </div>
    </button>
  )
}


export default function Pipelines() {
  const { config } = useConfigStore()
  // const queryClient = useQueryClient()
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null)
  const [editingStep, setEditingStep] = useState<PipelineStep | null>(null)
  const [showRawData, setShowRawData] = useState(false)

  // Mock pipelines data - in production this comes from API
  const [pipelines, setPipelines] = useState<Pipeline[]>([
    {
      id: 'trustpilot-default',
      source: 'trustpilot',
      name: 'Trustpilot Reviews',
      description: 'Process reviews from Trustpilot',
      enabled: true,
      status: 'success',
      lastRun: new Date().toISOString(),
      steps: [
        { id: '1', name: 'Fetch Reviews', type: 'extract', config: { endpoint: 'reviews' }, enabled: true },
        { id: '2', name: 'Normalize Data', type: 'transform', config: { text_field: 'text', rating_field: 'stars' }, enabled: true },
        { id: '3', name: 'Sentiment Analysis', type: 'enrich', config: {}, prompt: 'Analyze the sentiment of this customer review. Extract:\n- sentiment (positive/negative/neutral/mixed)\n- sentiment_score (-1 to 1)\n- category (delivery, product_quality, customer_support, pricing, other)\n- urgency (low/medium/high)\n- key_phrases\n\nReview: {text}', enabled: true },
        { id: '4', name: 'Filter Spam', type: 'filter', config: { min_length: 10, exclude_spam: true }, enabled: true },
        { id: '5', name: 'Save to DB', type: 'output', config: { table: 'feedback' }, enabled: true },
      ]
    },
    {
      id: 'appstore-apple-default',
      source: 'appstore_apple',
      name: 'Apple App Store',
      description: 'Process iOS app reviews',
      enabled: true,
      status: 'idle',
      steps: [
        { id: '1', name: 'Fetch RSS Feed', type: 'extract', config: {}, enabled: true },
        { id: '2', name: 'Parse Reviews', type: 'transform', config: {}, enabled: true },
        { id: '3', name: 'AI Analysis', type: 'enrich', config: {}, prompt: 'Analyze this app review...', enabled: true },
        { id: '4', name: 'Store', type: 'output', config: {}, enabled: true },
      ]
    },
  ])

  const currentPipeline = pipelines.find(p => p.id === selectedPipeline)

  const handleAddStep = () => {
    if (!currentPipeline) return
    const newStep: PipelineStep = {
      id: Date.now().toString(),
      name: 'New Step',
      type: 'transform',
      config: {},
      enabled: true
    }
    setPipelines(prev => prev.map(p => 
      p.id === selectedPipeline 
        ? { ...p, steps: [...p.steps, newStep] }
        : p
    ))
  }

  const handleUpdateStep = (updatedStep: PipelineStep) => {
    setPipelines(prev => prev.map(p =>
      p.id === selectedPipeline
        ? { ...p, steps: p.steps.map(s => s.id === updatedStep.id ? updatedStep : s) }
        : p
    ))
    setEditingStep(null)
  }

  const handleDeleteStep = (stepId: string) => {
    if (!confirm('Delete this step?')) return
    setPipelines(prev => prev.map(p =>
      p.id === selectedPipeline
        ? { ...p, steps: p.steps.filter(s => s.id !== stepId) }
        : p
    ))
  }

  const handleToggleStep = (stepId: string) => {
    setPipelines(prev => prev.map(p =>
      p.id === selectedPipeline
        ? { ...p, steps: p.steps.map(s => s.id === stepId ? { ...s, enabled: !s.enabled } : s) }
        : p
    ))
  }

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-gray-500 mb-4">Configure API endpoint first</p>
          <a href="/settings" className="btn btn-primary">Go to Settings</a>
        </div>
      </div>
    )
  }


  return (
    <div className="h-full flex flex-col lg:flex-row gap-6 overflow-hidden">
      {/* Sidebar - Pipeline List */}
      <div className="w-full lg:w-80 flex-shrink-0 space-y-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Data Pipelines</h2>
          <button className="btn btn-primary btn-sm flex items-center gap-1">
            <Plus size={14} /> New
          </button>
        </div>
        <div className="space-y-2">
          {pipelines.map(pipeline => (
            <PipelineCard
              key={pipeline.id}
              pipeline={pipeline}
              isSelected={selectedPipeline === pipeline.id}
              onSelect={() => setSelectedPipeline(pipeline.id)}
            />
          ))}
        </div>
      </div>

      {/* Main Content - Pipeline Editor */}
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        {currentPipeline ? (
          <div className="space-y-6">
            {/* Pipeline Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <span className="text-2xl">{SOURCE_ICONS[currentPipeline.source]}</span>
                  {currentPipeline.name}
                </h2>
                <p className="text-gray-500">{currentPipeline.description}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowRawData(!showRawData)}
                  className={clsx('btn btn-secondary flex items-center gap-2', showRawData && 'bg-blue-100')}
                >
                  <Eye size={16} /> {showRawData ? 'Hide' : 'Show'} Raw Data
                </button>
                <button className="btn btn-primary flex items-center gap-2">
                  <Play size={16} /> Run Pipeline
                </button>
              </div>
            </div>

            {/* Raw Data Preview */}
            {showRawData && (
              <div className="card bg-gray-900 text-gray-100">
                <h3 className="text-sm font-medium text-gray-400 mb-2">Sample Raw Data</h3>
                <pre className="text-xs overflow-x-auto">
{`{
  "id": "review_123",
  "text": "Great product! Fast delivery and excellent quality.",
  "rating": 5,
  "created_at": "2024-01-15T10:30:00Z",
  "author": "John D.",
  "source": "${currentPipeline.source}"
}`}
                </pre>
              </div>
            )}

            {/* Pipeline Steps Visual */}
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold">Processing Steps</h3>
                <button onClick={handleAddStep} className="btn btn-secondary btn-sm flex items-center gap-1">
                  <Plus size={14} /> Add Step
                </button>
              </div>
              
              <div className="flex flex-col gap-3">
                {currentPipeline.steps.map((step, index) => (
                  <div key={step.id} className="flex flex-col items-center gap-2">
                    <StepCard
                      step={step}
                      onEdit={() => setEditingStep(step)}
                      onDelete={() => handleDeleteStep(step.id)}
                      onToggle={() => handleToggleStep(step.id)}
                    />
                    {index < currentPipeline.steps.length - 1 && (
                      <ChevronRight className="text-gray-400 rotate-90" size={20} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Step Output Preview */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="card">
                <h3 className="font-semibold mb-2">Step Input</h3>
                <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto">
{`{
  "text": "Great product!",
  "rating": 5
}`}
                </pre>
              </div>
              <div className="card">
                <h3 className="font-semibold mb-2">Step Output</h3>
                <pre className="text-xs bg-green-50 p-3 rounded overflow-x-auto">
{`{
  "text": "Great product!",
  "rating": 5,
  "sentiment": "positive",
  "sentiment_score": 0.92,
  "category": "product_quality"
}`}
                </pre>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            Select a pipeline to configure
          </div>
        )}
      </div>

      {/* Step Editor Modal */}
      {editingStep && (
        <StepEditor
          step={editingStep}
          onSave={handleUpdateStep}
          onClose={() => setEditingStep(null)}
        />
      )}
    </div>
  )
}
