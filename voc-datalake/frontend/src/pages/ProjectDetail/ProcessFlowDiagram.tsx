/**
 * ProcessFlowDiagram - Visual process map showing the consulting workflow
 * Displays step-by-step progression from data collection to PRD generation
 */
import { Database, Users, GitCompareArrows, FileText, Search, ArrowRight, CheckCircle2 } from 'lucide-react'
import type { ProjectPersona, ProjectDocument } from '../../api/client'

interface ProcessFlowDiagramProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly onStepClick: (step: string) => void
}

interface Step {
  id: string
  label: string
  sublabel: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  color: string
  docTypes: string[]
}

const ALL_STEPS: Step[] = [
  {
    id: 'data',
    label: 'Collect VoC Data',
    sublabel: 'Feedback ingestion',
    icon: Database,
    color: 'gray',
    docTypes: []
  },
  {
    id: 'personas',
    label: 'Build Personas',
    sublabel: 'User research',
    icon: Users,
    color: 'purple',
    docTypes: []
  },
  {
    id: 'process',
    label: 'As-Is / To-Be',
    sublabel: 'Process analysis',
    icon: GitCompareArrows,
    color: 'teal',
    docTypes: ['process_analysis']
  },
  {
    id: 'research',
    label: 'Deep Research',
    sublabel: 'Market insights',
    icon: Search,
    color: 'amber',
    docTypes: ['research']
  },
  {
    id: 'prd',
    label: 'Generate PRD',
    sublabel: 'Requirements doc',
    icon: FileText,
    color: 'blue',
    docTypes: ['prd', 'prfaq']
  },
]

const colorMap: Record<string, { bg: string; border: string; text: string; iconBg: string }> = {
  gray: { bg: 'bg-gray-50', border: 'border-gray-300', text: 'text-gray-700', iconBg: 'bg-gray-200 text-gray-600' },
  purple: { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700', iconBg: 'bg-purple-100 text-purple-600' },
  teal: { bg: 'bg-teal-50', border: 'border-teal-300', text: 'text-teal-700', iconBg: 'bg-teal-100 text-teal-600' },
  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-700', iconBg: 'bg-indigo-100 text-indigo-600' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-700', iconBg: 'bg-amber-100 text-amber-600' },
  blue: { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700', iconBg: 'bg-blue-100 text-blue-600' },
}

export default function ProcessFlowDiagram({ personas, documents, onStepClick }: ProcessFlowDiagramProps) {
  const getStepStatus = (step: Step) => {
    if (step.id === 'data') return 'complete'
    if (step.id === 'personas') return personas.length > 0 ? 'complete' : 'available'
    if (step.docTypes.length > 0) {
      const hasDoc = documents.some(d => step.docTypes.includes(d.document_type ?? ''))
      return hasDoc ? 'complete' : 'available'
    }
    return 'available'
  }

  return (
    <div className="bg-white rounded-xl border p-4 sm:p-6">
      <h3 className="font-semibold text-sm text-gray-500 uppercase tracking-wider mb-4">
        Consulting Workflow
      </h3>
      <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto pb-2">
        {ALL_STEPS.map((step, idx) => {
          const status = getStepStatus(step)
          const colors = colorMap[step.color]
          const Icon = step.icon
          const isClickable = step.id !== 'data'

          return (
            <div key={step.id} className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              <button
                onClick={() => isClickable && onStepClick(step.id)}
                disabled={!isClickable}
                className={`relative flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border-2 transition-all min-w-[90px] sm:min-w-[110px] ${
                  isClickable ? 'cursor-pointer hover:shadow-md hover:scale-105' : 'cursor-default'
                } ${status === 'complete' ? `${colors.bg} ${colors.border}` : 'bg-white border-gray-200'}`}
              >
                {status === 'complete' && (
                  <CheckCircle2 size={14} className="absolute top-1 right-1 text-green-500" />
                )}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${status === 'complete' ? colors.iconBg : 'bg-gray-100 text-gray-400'}`}>
                  <Icon size={16} />
                </div>
                <span className={`text-xs font-medium text-center leading-tight ${status === 'complete' ? colors.text : 'text-gray-500'}`}>
                  {step.label}
                </span>
                <span className="text-[10px] text-gray-400 text-center leading-tight hidden sm:block">
                  {step.sublabel}
                </span>
              </button>
              {idx < ALL_STEPS.length - 1 && (
                <ArrowRight size={16} className="text-gray-300 flex-shrink-0" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
