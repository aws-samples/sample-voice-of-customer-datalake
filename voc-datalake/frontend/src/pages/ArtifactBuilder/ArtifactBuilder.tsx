/**
 * Artifact Builder - Generate web prototypes from prompts using Kiro CLI
 * Default view shows artifact history, with a modal for building new artifacts
 */

import {
  Sparkles,
  Loader2,
  Plus,
  GitBranch,
} from 'lucide-react'
import { useArtifactBuilderState } from './useArtifactBuilderState'
import {
  StatusBadge,
  NotConfiguredView,
  EmptyJobsList,
  JobCard,
  DetailTabs,
  JobActions,
  NoJobSelected,
} from './ArtifactBuilderComponents'
import { BuildModal, IterateModal, SourceModal } from './ArtifactBuilderModals'
import { formatDate } from './artifactBuilderHelpers'

// Preview Tab Content
function PreviewTabContent({ selectedJob }: Readonly<{ selectedJob: { status: string; preview_url?: string; job_id: string } }>) {
  if (selectedJob.status === 'done' && selectedJob.preview_url) {
    return (
      <iframe
        src={selectedJob.preview_url}
        className="w-full h-full border-0"
        title={`Preview for job ${selectedJob.job_id}`}
      />
    )
  }
  
  if (selectedJob.status === 'done') {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <p>Preview not available</p>
      </div>
    )
  }
  
  return (
    <div className="flex flex-col items-center justify-center h-full text-gray-500">
      <Loader2 className="w-8 h-8 animate-spin mb-3 text-purple-500" />
      <p className="font-medium">Building artifact...</p>
      <p className="text-sm mt-1">Status: {selectedJob.status}</p>
    </div>
  )
}

// Prompt Tab Content
function PromptTabContent({ selectedJob }: Readonly<{ selectedJob: { project_type: string; style: string; include_mock_data?: boolean; prompt: string } }>) {
  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="mb-4 flex flex-wrap gap-2">
        <span className="px-2 py-1 bg-gray-100 rounded text-xs">{selectedJob.project_type}</span>
        <span className="px-2 py-1 bg-gray-100 rounded text-xs">{selectedJob.style}</span>
        {selectedJob.include_mock_data && (
          <span className="px-2 py-1 bg-gray-100 rounded text-xs">Mock Data</span>
        )}
      </div>
      <p className="text-gray-900 whitespace-pre-wrap bg-gray-50 p-4 rounded-lg text-sm">
        {selectedJob.prompt}
      </p>
    </div>
  )
}

// Logs Tab Content
function LogsTabContent({ logs }: Readonly<{ logs: string | undefined }>) {
  return (
    <div className="h-full p-4">
      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-xs font-mono h-full whitespace-pre-wrap">
        {logs ?? 'Waiting for logs...'}
      </pre>
    </div>
  )
}

// Parent Job Info
function ParentJobInfo({ parentJobId, onViewParent }: Readonly<{ parentJobId: string; onViewParent: () => void }>) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-purple-600 bg-purple-50 px-2 sm:px-3 py-2 rounded-lg mb-3">
      <GitBranch className="w-3 h-3 sm:w-4 sm:h-4" />
      <span>Iterated from job #{parentJobId.slice(0, 8)}</span>
      <button onClick={onViewParent} className="underline hover:text-purple-800">
        View parent
      </button>
    </div>
  )
}

// Error Message
function ErrorMessage({ error }: Readonly<{ error: string }>) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-2 sm:p-3 mb-3">
      <p className="text-xs sm:text-sm text-red-700">{error}</p>
    </div>
  )
}

// Job Detail Header
interface JobDetailHeaderProps {
  readonly selectedJob: {
    job_id: string
    created_at: string
    status: string
    error?: string
    parent_job_id?: string
  }
  readonly isDeleting: boolean
  readonly onOpenSource: (jobId: string) => void
  readonly onOpenIterate: (jobId: string) => void
  readonly onDelete: (jobId: string) => void
  readonly onViewParent: (jobId: string) => void
}

function JobDetailHeader({ selectedJob, isDeleting, onOpenSource, onOpenIterate, onDelete, onViewParent }: JobDetailHeaderProps) {
  return (
    <div className="p-3 sm:p-4 border-b shrink-0">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-0 mb-3">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm sm:text-base">Job #{selectedJob.job_id.slice(0, 8)}</h3>
          <p className="text-xs sm:text-sm text-gray-500">{formatDate(selectedJob.created_at)}</p>
        </div>
        <StatusBadge status={selectedJob.status} />
      </div>

      {selectedJob.status === 'failed' && selectedJob.error && (
        <ErrorMessage error={selectedJob.error} />
      )}

      {selectedJob.parent_job_id && (
        <ParentJobInfo 
          parentJobId={selectedJob.parent_job_id} 
          onViewParent={() => onViewParent(selectedJob.parent_job_id ?? '')} 
        />
      )}

      <JobActions
        job={selectedJob}
        isDeleting={isDeleting}
        onOpenSource={onOpenSource}
        onOpenIterate={onOpenIterate}
        onDelete={onDelete}
      />
    </div>
  )
}

// Tab Content Renderer
interface TabContentProps {
  readonly detailTab: 'preview' | 'prompt' | 'logs'
  readonly selectedJob: {
    status: string
    preview_url?: string
    job_id: string
    project_type: string
    style: string
    include_mock_data?: boolean
    prompt: string
  }
  readonly logs: string | undefined
}

function TabContent({ detailTab, selectedJob, logs }: TabContentProps) {
  if (detailTab === 'preview') {
    return <PreviewTabContent selectedJob={selectedJob} />
  }
  if (detailTab === 'prompt') {
    return <PromptTabContent selectedJob={selectedJob} />
  }
  return <LogsTabContent logs={logs} />
}

// Jobs List Component
interface JobsListProps {
  readonly jobsLoading: boolean
  readonly jobs: ReadonlyArray<unknown>
  readonly groupedJobs: ReadonlyArray<{
    job_id: string
    status: string
    prompt: string
    created_at: string
    parent_job_id?: string
    iterations?: ReadonlyArray<{
      job_id: string
      status: string
      prompt: string
      created_at: string
    }>
  }>
  readonly selectedJobId: string | null
  readonly expandedParents: Set<string>
  readonly onSelectJob: (jobId: string) => void
  readonly onToggleExpand: (jobId: string) => void
  readonly onBuildClick: () => void
}

function JobsList({
  jobsLoading,
  jobs,
  groupedJobs,
  selectedJobId,
  expandedParents,
  onSelectJob,
  onToggleExpand,
  onBuildClick,
}: JobsListProps) {
  if (jobsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </div>
    )
  }
  
  if (jobs.length === 0) {
    return <EmptyJobsList onBuildClick={onBuildClick} />
  }
  
  return (
    <>
      {groupedJobs.map((job) => (
        <JobCard
          key={job.job_id}
          job={job}
          isSelected={selectedJobId === job.job_id}
          isExpanded={expandedParents.has(job.job_id)}
          selectedJobId={selectedJobId}
          onSelect={onSelectJob}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </>
  )
}

export default function ArtifactBuilder() {
  const state = useArtifactBuilderState()

  if (!state.isConfigured) {
    return <NotConfiguredView />
  }

  return (
    <div className="space-y-6">
      {/* Header with Build button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-purple-500" />
            Artifacts
          </h1>
          <p className="text-sm sm:text-base text-gray-500 mt-1">Generated web prototypes from prompts</p>
        </div>
        <button
          onClick={() => state.setShowBuildModal(true)}
          className="flex items-center justify-center gap-2 px-4 sm:px-5 py-2 sm:py-2.5 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-medium rounded-xl shadow-lg shadow-purple-500/25 transition-all text-sm sm:text-base"
        >
          <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
          Build New Artifact
        </button>
      </div>

      {/* Artifacts List */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Jobs List */}
        <div className="lg:col-span-1 space-y-3">
          <h2 className="font-semibold text-gray-900">All Artifacts</h2>
          <JobsList
            jobsLoading={state.jobsLoading}
            jobs={state.jobs}
            groupedJobs={state.groupedJobs}
            selectedJobId={state.selectedJobId}
            expandedParents={state.expandedParents}
            onSelectJob={state.setSelectedJobId}
            onToggleExpand={state.toggleParentExpanded}
            onBuildClick={() => state.setShowBuildModal(true)}
          />
        </div>

        {/* Job Details */}
        <div className="lg:col-span-2">
          {state.selectedJob ? (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col h-[60vh] sm:h-[70vh] lg:h-[calc(100vh-180px)]">
              <JobDetailHeader
                selectedJob={state.selectedJob}
                isDeleting={state.deleteJob.isPending}
                onOpenSource={state.openSourceModal}
                onOpenIterate={state.openIterateModal}
                onDelete={(jobId) => state.deleteJob.mutate(jobId)}
                onViewParent={(jobId) => state.setSelectedJobId(jobId)}
              />

              <DetailTabs activeTab={state.detailTab} onTabChange={state.setDetailTab} />

              <div className="flex-1 overflow-hidden">
                <TabContent
                  detailTab={state.detailTab}
                  selectedJob={state.selectedJob}
                  logs={state.logsData?.logs}
                />
              </div>
            </div>
          ) : (
            <NoJobSelected />
          )}
        </div>
      </div>

      {/* Build Modal */}
      {state.showBuildModal && (
        <BuildModal
          templates={state.templates}
          styles={state.styles}
          isCreating={state.createJob.isPending}
          createError={state.createJob.error instanceof Error ? state.createJob.error : null}
          onClose={() => state.setShowBuildModal(false)}
          onSubmit={state.handleCreateJob}
        />
      )}

      {/* Iterate Modal */}
      {state.showIterateModal && state.iterateFromJobId && (
        <IterateModal
          jobId={state.iterateFromJobId}
          isIterating={state.iterateJob.isPending}
          onClose={state.closeIterateModal}
          onSubmit={state.handleIterate}
        />
      )}

      {/* Source Modal */}
      {state.showSourceModal && state.sourceJobId && (
        <SourceModal
          jobId={state.sourceJobId}
          downloadUrl={state.downloadData?.download_url}
          sourceFiles={state.sourceFiles}
          sourceFilesLoading={state.sourceFilesLoading}
          selectedSourceFile={state.selectedSourceFile}
          sourceFileContent={state.sourceFileContent}
          sourceFileLoading={state.sourceFileLoading}
          currentSourcePath={state.currentSourcePath}
          onClose={state.closeSourceModal}
          onLoadFiles={state.loadSourceFiles}
          onLoadFileContent={state.handleLoadSourceFileContent}
          onCopyClone={state.copyCloneCommand}
          copiedClone={state.copiedClone}
        />
      )}
    </div>
  )
}
