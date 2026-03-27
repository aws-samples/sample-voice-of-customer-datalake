/**
 * OverviewTab - Project overview with action cards and jobs
 */
import {
  Users, FileText, Search, Sparkles, Shuffle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import JobsSection from './JobsSection'
import KiroExportSettings from './KiroExportSettings'
import type {
  ProjectPersona, ProjectDocument, Project, ProjectJob,
} from '../../api/types'

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
  const { t } = useTranslation('projectDetail')

  return (
    <div className="space-y-6">
      {/* Running Jobs Section */}
      <JobsSection jobs={jobs} onDismiss={onDismissJob} />

      {/* Action Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <ActionCard
          icon={<Users size={20} className="text-purple-600" />}
          iconBg="bg-purple-100"
          title={t('overview.generatePersonas')}
          description={t('overview.generatePersonasDesc')}
          buttonColor="bg-purple-600 hover:bg-purple-700"
          buttonIcon={<Sparkles size={16} />}
          buttonLabel={t('overview.generate')}
          configureLabel={t('overview.configureAnd')}
          onClick={onGeneratePersonas}
        />
        <ActionCard
          icon={<FileText size={20} className="text-blue-600" />}
          iconBg="bg-blue-100"
          title={t('overview.generatePrdPrfaq')}
          description={t('overview.generatePrdPrfaqDesc')}
          buttonColor="bg-blue-600 hover:bg-blue-700"
          buttonIcon={<FileText size={16} />}
          buttonLabel={t('overview.generate')}
          configureLabel={t('overview.configureAnd')}
          onClick={onGenerateDoc}
        />
        <ActionCard
          icon={<Search size={20} className="text-amber-600" />}
          iconBg="bg-amber-100"
          title={t('overview.runResearch')}
          description={t('overview.runResearchDesc')}
          buttonColor="bg-amber-600 hover:bg-amber-700"
          buttonIcon={<Search size={16} />}
          buttonLabel={t('overview.runResearch')}
          configureLabel={t('overview.configureAnd')}
          onClick={onRunResearch}
        />
        <ActionCard
          icon={<Shuffle size={20} className="text-green-600" />}
          iconBg="bg-green-100"
          title={t('overview.remixDocuments')}
          description={t('overview.remixDocumentsDesc')}
          buttonColor="bg-green-600 hover:bg-green-700"
          buttonIcon={<Shuffle size={16} />}
          buttonLabel={t('overview.selectAndRemix')}
          configureLabel={t('overview.configureAnd')}
          onClick={onRemixDocuments}
          disabled={documents.length < 2}
          disabledMessage={t('overview.needAtLeast2Docs')}
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
  readonly configureLabel: string
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
  configureLabel,
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
        <span className="hidden sm:inline">{configureLabel}</span>{buttonLabel}
      </button>
      {disabled === true && disabledMessage != null && disabledMessage !== '' ? <p className="text-xs text-gray-400 mt-2 text-center">{disabledMessage}</p> : null}
    </div>
  )
}
