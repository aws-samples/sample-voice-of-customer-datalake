/**
 * OverviewTab - Project overview with action cards and jobs
 */
import { Users, FileText, Search, Sparkles, Shuffle } from 'lucide-react'
import type { ProjectPersona, ProjectDocument, Project } from '../../api/client'
import type { ProjectJob } from '../../api/client'
import JobsSection from './JobsSection'
import KiroExportSettings from './KiroExportSettings'

interface OverviewTabProps {
  readonly project: Project
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly jobs: ProjectJob[]
  readonly onGeneratePersonas: () => void
  readonly onGenerateDoc: () => void
  readonly onRunResearch: () => void
  readonly onRemixDocuments: () => void
  readonly onDismissJob: (jobId: string) => void
  readonly onSaveKiroPrompt: (prompt: string) => void
}

export default function OverviewTab({
  project,
  documents,
  jobs,
  onGeneratePersonas,
  onGenerateDoc,
  onRunResearch,
  onRemixDocuments,
  onDismissJob,
  onSaveKiroPrompt,
}: OverviewTabProps) {
  return (
    <div className="space-y-6">
      {/* Running Jobs Section */}
      <JobsSection jobs={jobs} onDismiss={onDismissJob} />
      
      {/* Action Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <ActionCard
          icon={<Users size={20} className="text-purple-600" />}
          iconBg="bg-purple-100"
          title="Generate Personas"
          description="Create user personas from feedback"
          buttonColor="bg-purple-600 hover:bg-purple-700"
          buttonIcon={<Sparkles size={16} />}
          buttonLabel="Generate"
          onClick={onGeneratePersonas}
        />
        <ActionCard
          icon={<FileText size={20} className="text-blue-600" />}
          iconBg="bg-blue-100"
          title="Generate PRD / PR-FAQ"
          description="Create product documents from feedback"
          buttonColor="bg-blue-600 hover:bg-blue-700"
          buttonIcon={<FileText size={16} />}
          buttonLabel="Generate"
          onClick={onGenerateDoc}
        />
        <ActionCard
          icon={<Search size={20} className="text-amber-600" />}
          iconBg="bg-amber-100"
          title="Run Research"
          description="Deep dive into feedback with filters"
          buttonColor="bg-amber-600 hover:bg-amber-700"
          buttonIcon={<Search size={16} />}
          buttonLabel="Run Research"
          onClick={onRunResearch}
        />
        <ActionCard
          icon={<Shuffle size={20} className="text-green-600" />}
          iconBg="bg-green-100"
          title="Remix Documents"
          description="Combine and revise documents into new versions"
          buttonColor="bg-green-600 hover:bg-green-700"
          buttonIcon={<Shuffle size={16} />}
          buttonLabel="Select & Remix"
          onClick={onRemixDocuments}
          disabled={documents.length < 2}
          disabledMessage="Need at least 2 documents"
        />
      </div>

      {/* Kiro Export Settings */}
      <KiroExportSettings project={project} onSave={onSaveKiroPrompt} />
    </div>
  )
}

interface ActionCardProps {
  readonly icon: React.ReactNode
  readonly iconBg: string
  readonly title: string
  readonly description: string
  readonly buttonColor: string
  readonly buttonIcon: React.ReactNode
  readonly buttonLabel: string
  readonly onClick: () => void
  readonly disabled?: boolean
  readonly disabledMessage?: string
}

function ActionCard({
  icon,
  iconBg,
  title,
  description,
  buttonColor,
  buttonIcon,
  buttonLabel,
  onClick,
  disabled,
  disabledMessage,
}: ActionCardProps) {
  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 border">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 ${iconBg} rounded-lg flex items-center justify-center flex-shrink-0`}>
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-sm sm:text-base">{title}</h3>
          <p className="text-xs sm:text-sm text-gray-500">{description}</p>
        </div>
      </div>
      <button 
        onClick={onClick} 
        disabled={disabled}
        className={`w-full py-2 text-white rounded-lg flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed ${buttonColor}`}
      >
        {buttonIcon}
        <span className="hidden sm:inline">Configure & </span>{buttonLabel}
      </button>
      {disabled && disabledMessage && (
        <p className="text-xs text-gray-400 mt-2 text-center">{disabledMessage}</p>
      )}
    </div>
  )
}


