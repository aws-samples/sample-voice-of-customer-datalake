/**
 * @fileoverview Project detail page with personas, documents and product context.
 * (The former Chat tab is gone: the floating assistant knows the project.)
 * Split into multiple components for maintainability.
 */
import { Loader2 } from 'lucide-react'
import {
  useState, useCallback, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  useParams, useNavigate, useSearchParams,
} from 'react-router-dom'
import { useDocumentSave } from './useDocumentSave'
import ProjectSharingModal from '../../components/ProjectSharingModal/ProjectSharingModal'
import { useConfigStore } from '../../store/configStore'
import JobsBadge from './JobsBadge'
import ProjectHeader from './ProjectHeader'
import {
  DocumentModalWrapper, ConfirmModalWrapper, CopyPersonasModalWrapper,
} from './ProjectModals'
import ProjectTabs from './ProjectTabs'
import ReadOnlyBanner from './ReadOnlyBanner'
import { canEditProject } from './projectAccess'
import TabContent from './TabContent'
import {
  useSelectionState, useDocModalState, useImportModalState, useConfirmModalState, personaListHandlers,
} from './useModalState'
import {
  useProjectData, useProjectMutations, useDocumentMutations,
} from './useProjectData'
import { usePersonaMutations } from './usePersonaMutations'
import PersonaModals from './PersonaModals'
import { projectPersonaScope } from './personaScope'
import { projectJobsKey } from '../../api/projectQueryKeys'
import { projectDocumentPath, useDocumentSelection } from './useDocumentSelection'
import { useProjectWizardState } from './useProjectWizardState'
import WizardSection from './WizardSection'
import { parseTab } from './types'
import type { Tab } from './types'

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { config } = useConfigStore()

  // The active tab lives in `?tab=` so the assistant's page context can name it.
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = parseTab(searchParams.get('tab'))
  const setActiveTab = useCallback((tab: Tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (tab === 'overview') next.delete('tab')
      else next.set('tab', tab)
      return next
    }, { replace: true })
  }, [setSearchParams])
  // An unknown `?tab=` (an old `mcp` or `chat` bookmark) renders Overview, so drop it
  // from the URL too: the address bar and the assistant's page context then agree.
  const rawTab = searchParams.get('tab')
  useEffect(() => {
    if (rawTab !== null && rawTab !== activeTab) setActiveTab(activeTab)
  }, [rawTab, activeTab, setActiveTab])
  // When a long-running action last reported that it started a job. Keeps the
  // jobs poll alive while the new row becomes readable — see
  // JOB_START_POLL_WINDOW_MS in useProjectData.
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null)
  const [showSharing, setShowSharing] = useState(false)
  const [showCopyPersonas, setShowCopyPersonas] = useState(false)
  const { t } = useTranslation('projectDetail')

  // Custom hooks for state management
  const wizard = useProjectWizardState()
  const selection = useSelectionState()
  const docModal = useDocModalState()
  const importModal = useImportModalState()
  const confirm = useConfirmModalState()

  // Data fetching
  const {
    data, isLoading, jobsData, productContext, productDocs, designSystem, queryClient,
  } = useProjectData({
    id,
    apiEndpoint: config.apiEndpoint,
    jobStartedAt,
  })

  // The Documents tab's selection, deep-linkable as `?doc=<id>`.
  const docSelection = useDocumentSelection(data?.documents)

  // Mutations
  const {
    personaMut, docMut, resMut, mergeMut, dismissJobMut,
  } = useProjectMutations({
    id,
    contextConfig: wizard.contextConfig,
    personaConfig: wizard.personaConfig,
    researchConfig: wizard.researchConfig,
    docConfig: wizard.docConfig,
    mergeConfig: wizard.mergeConfig,
    documents: data?.documents,
    onSuccess: wizard.resetWizard,
    onError: () => wizard.setGenerating(null),
  })

  const personaMutations = usePersonaMutations({
    scope: projectPersonaScope(id),
    selectedPersona: selection.selectedPersona,
    editingPersona: selection.editingPersona,
    setEditingPersona: selection.setEditingPersona,
    setSelectedPersona: selection.setSelectedPersona,
  })
  const { updatePersonaMut, deletePersonaMut, saveNotes } = personaMutations

  const {
    createDocMut, deleteDocMut, updateDocMut,
  } = useDocumentMutations({
    id,
    selectedDoc: docSelection.selectedDoc,
    setSelectedDoc: docSelection.setSelectedDoc,
  })

  // Handlers
  /**
   * Long-running actions (prototype build, prototype revision, product report)
   * hand their wait to the Background Jobs panel instead of polling in local
   * state. Invalidating is what makes the panel *see* the new job: its
   * refetchInterval is 0 whenever nothing is already in flight (see
   * useProjectData), so without this the panel would never start polling and a
   * build started from an idle project would stay invisible.
   *
   * The timestamp matters as much as the invalidation. The invalidation buys one
   * refetch, and the job row is read without ConsistentRead, so that one refetch
   * can come back empty and leave the panel blind again. Recording the start
   * keeps the poll alive until the row appears.
   *
   * The wizard mutations invalidate for themselves in useProjectMutations, and
   * are unaffected: their jobs are created on the same synchronous path.
   */
  const handleJobStarted = useCallback(() => {
    setJobStartedAt(Date.now())
    void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) })
  }, [queryClient, id])

  const handleConfirmDelete = useCallback(() => {
    const {
      type, id: itemId,
    } = confirm.confirmModal
    if (type === 'persona' && itemId != null && itemId !== '') deletePersonaMut.mutate(itemId)
    else if (type === 'document' && itemId != null && itemId !== '') deleteDocMut.mutate(itemId)
    confirm.closeConfirm()
  }, [confirm, deletePersonaMut, deleteDocMut])

  // The document save returns its promise (resolve = saved, reject = failed), like the
  // persona save (usePersonaMutations), so the editor's unsaved-changes guard can wait (E2E F6).
  const documentSave = useDocumentSave({
    projectId: id,
    queryClient,
    docModal,
    updateDoc: updateDocMut.mutateAsync,
    createDoc: createDocMut.mutateAsync,
  })

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    )
  }

  // Not found state
  if (data?.project == null) {
    return (
      <div className="text-center py-12">
        <p className="text-muted">{t('notFound.message')}</p>
        <button
          onClick={() => {
            void navigate('/projects')
          }}
          className="mt-4 link"
        >
          {t('notFound.backToProjects')}
        </button>
      </div>
    )
  }

  const {
    project, personas, documents,
  } = data
  const jobs = jobsData?.jobs ?? []
  // Viewers see the banner and none of the controls that would only 403.
  const canEdit = canEditProject(project)

  return (
    <div className="space-y-6">
      <ProjectHeader
        name={project.name}
        description={project.description}
        visibility={project.visibility}
        onShare={() => setShowSharing(true)}
        projectId={project.project_id}
        // Background jobs: one header badge on every tab, opening the jobs panel. Dismissing a
        // job is a DELETE the gate refuses for viewers, so they get no handler and no button.
        status={<JobsBadge jobs={jobs} onDismiss={canEdit ? (jobId: string) => dismissJobMut.mutate(jobId) : undefined} />}
        onBack={() => {
          void navigate('/projects')
        }}
      />
      {canEdit ? null : <ReadOnlyBanner />}
      <ProjectSharingModal
        isOpen={showSharing}
        onClose={() => setShowSharing(false)}
        projectId={project.project_id}
        projectName={project.name}
        onLeft={() => {
          void navigate('/projects')
        }}
      />
      <ProjectTabs
        activeTab={activeTab}
        personasCount={personas.length}
        documentsCount={documents.length}
        onTabChange={setActiveTab}
      />

      <WizardSection
        activeWizard={wizard.activeWizard}
        projectId={project.project_id}
        personas={personas}
        documents={documents}
        contextConfig={wizard.contextConfig}
        personaConfig={wizard.personaConfig}
        researchConfig={wizard.researchConfig}
        docConfig={wizard.docConfig}
        mergeConfig={wizard.mergeConfig}
        generating={wizard.generating}
        personaStartError={personaMut.error}
        researchStartError={resMut.error}
        onContextChange={wizard.setContextConfig}
        onPersonaConfigChange={wizard.setPersonaConfig}
        onResearchConfigChange={wizard.setResearchConfig}
        onDocConfigChange={wizard.setDocConfig}
        onMergeConfigChange={wizard.setMergeConfig}
        onClose={() => {
          // A refusal belongs to the attempt it answered, not to the next opening.
          personaMut.reset(); resMut.reset(); wizard.resetWizard()
        }}
        onSubmitPersona={() => {
          wizard.setGenerating('personas'); personaMut.mutate()
        }}
        onSubmitResearch={() => {
          wizard.setGenerating('research'); resMut.mutate()
        }}
        onSubmitDoc={() => {
          wizard.setGenerating('doc'); docMut.mutate()
        }}
        onSubmitMerge={() => {
          wizard.setGenerating('merge'); mergeMut.mutate()
        }}
        onOpenDocument={(documentId) => void navigate(projectDocumentPath(project.project_id, documentId))}
      />

      <TabContent
        activeTab={activeTab}
        project={project}
        canEdit={canEdit}
        personas={personas}
        documents={documents}
        productContext={productContext}
        productDocs={productDocs}
        designSystem={designSystem}
        selectedPersona={selection.selectedPersona}
        selectedDoc={docSelection.selectedDoc}
        isDeleting={deletePersonaMut.isPending || deleteDocMut.isPending}
        isSavingNotes={updatePersonaMut.isPending}
        onGeneratePersonas={() => wizard.setActiveWizard('persona')}
        onGenerateDoc={() => wizard.setActiveWizard('doc')}
        onRunResearch={() => wizard.openResearchWizard(personas.map((p) => p.persona_id))}
        onRemixDocuments={wizard.openMergeWizard}
        onOpenProductTool={() => setActiveTab('product')}
        {...personaListHandlers(selection, confirm)}
        onSaveNotes={saveNotes}
        onImportPersona={() => importModal.setShowImportModal(true)}
        onCopyPersonas={() => setShowCopyPersonas(true)}
        onSelectDoc={docSelection.setSelectedDoc}
        onEditDoc={() => docSelection.selectedDoc && docModal.openEditModal(docSelection.selectedDoc)}
        onDeleteDoc={() => docSelection.selectedDoc && confirm.openDocumentConfirm(docSelection.selectedDoc.document_id)}
        onCreateDoc={docModal.openCreateModal}
        onJobStarted={handleJobStarted}
      />

      <PersonaModals selection={selection} importModal={importModal} mutations={personaMutations} />

      <CopyPersonasModalWrapper
        showModal={showCopyPersonas}
        projectId={project.project_id}
        onClose={() => setShowCopyPersonas(false)}
        // Show the first copy, so the result of the copy is on screen.
        onCopied={(copies) => selection.setSelectedPersona(copies.at(0) ?? null)}
      />

      <DocumentModalWrapper
        showModal={docModal.showDocModal}
        editingDoc={docModal.editingDoc}
        title={docModal.newDocTitle}
        content={docModal.newDocContent}
        isSaving={docModal.editingDoc ? updateDocMut.isPending : createDocMut.isPending}
        onTitleChange={docModal.setNewDocTitle}
        onContentChange={docModal.setNewDocContent}
        onSave={documentSave.save}
        onClose={docModal.closeModal}
        conflict={documentSave.conflict}
      />

      <ConfirmModalWrapper
        type={confirm.confirmModal.type}
        onConfirm={handleConfirmDelete}
        onCancel={confirm.closeConfirm}
      />
    </div>
  )
}
