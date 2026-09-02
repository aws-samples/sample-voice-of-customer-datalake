/**
 * @fileoverview Project detail page with personas, documents, and chat.
 * Split into multiple components for maintainability.
 */
import { Loader2 } from 'lucide-react'
import {
  useState, useCallback,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  useParams, useNavigate,
} from 'react-router-dom'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { useConfigStore } from '../../store/configStore'
import JobsSection from './JobsSection'
import ProjectHeader from './ProjectHeader'
import {
  PersonaEditModalWrapper, ImportPersonaModalWrapper, DocumentModalWrapper, ConfirmModalWrapper,
} from './ProjectModals'
import ProjectTabs from './ProjectTabs'
import TabContent from './TabContent'
import {
  useSelectionState, useDocModalState, useImportModalState, useConfirmModalState,
} from './useModalState'
import {
  useProjectData, useProjectMutations, usePersonaMutations, useDocumentMutations, projectJobsKey,
  productContextKey,
} from './useProjectData'
import { useProjectWizardState } from './useProjectWizardState'
import WizardSection from './WizardSection'
import type { Tab } from './types'
import type { ProductContext } from '../../api/types'

/** The product-context query's data shape, taken from the call that produces it. */
type ProductContextResponse = Awaited<ReturnType<typeof projectsApi.getProductContext>>

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { config } = useConfigStore()

  const [activeTab, setActiveTab] = useState<Tab>('overview')
  // When a long-running action last reported that it started a job. Keeps the
  // jobs poll alive while the new row becomes readable — see
  // JOB_START_POLL_WINDOW_MS in useProjectData.
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null)
  const { t } = useTranslation('projectDetail')

  // Custom hooks for state management
  const wizard = useProjectWizardState()
  const selection = useSelectionState()
  const docModal = useDocModalState()
  const importModal = useImportModalState()
  const confirm = useConfirmModalState()

  // Data fetching
  const {
    data, isLoading, jobsData, productContext, productDocs, queryClient,
  } = useProjectData({
    id,
    apiEndpoint: config.apiEndpoint,
    jobStartedAt,
  })

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
    onSuccess: wizard.resetWizard,
    onError: () => wizard.setGenerating(null),
  })

  const {
    updatePersonaMut, deletePersonaMut, importPersonaMut, saveNotes,
  } = usePersonaMutations({
    id,
    selectedPersona: selection.selectedPersona,
    editingPersona: selection.editingPersona,
    setEditingPersona: selection.setEditingPersona,
    setSelectedPersona: selection.setSelectedPersona,
  })

  const {
    createDocMut, deleteDocMut, updateDocMut,
  } = useDocumentMutations({
    id,
    selectedDoc: selection.selectedDoc,
    setSelectedDoc: selection.setSelectedDoc,
  })

  // Handlers
  const handleImportPersona = useCallback(() => {
    importPersonaMut.mutate(
      {
        input_type: importModal.importType,
        content: importModal.importContent,
        media_type: importModal.importMediaType,
      },
      { onSuccess: importModal.closeModal },
    )
  }, [importPersonaMut, importModal])

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

  /**
   * The Product tab saved the context. It owns the record while editing, but the
   * Overview card reads completeness from the shared query — and this page stays
   * mounted across tab switches, so without this the card would keep reporting the
   * count from page load.
   *
   * Seeding the cache rather than invalidating: the tab hands over the server's own
   * response, so a refetch would ask for what we already have.
   */
  const handleContextSaved = useCallback((context: ProductContext) => {
    // Typed from the API function itself rather than as a bare object literal:
    // `setQueryData` cannot infer a plain key's data type, so an untyped write
    // would silently truncate the cache entry if `getProductContext` ever returned
    // more than `{ context }`. Deriving the type means the two cannot drift.
    queryClient.setQueryData<ProductContextResponse>(productContextKey(id), { context })
  }, [queryClient, id])

  const handleSaveKiroPrompt = useCallback((prompt: string) => {
    const project = data?.project
    if (project == null) return
    void projectsApi.updateProject(project.project_id, { kiro_export_prompt: prompt })
      .then(() => {
        return queryClient.invalidateQueries({ queryKey: projectKey(id) })
      })
  }, [data, queryClient, id])

  const handleConfirmDelete = useCallback(() => {
    const {
      type, id: itemId,
    } = confirm.confirmModal
    if (type === 'persona' && itemId != null && itemId !== '') deletePersonaMut.mutate(itemId)
    else if (type === 'document' && itemId != null && itemId !== '') deleteDocMut.mutate(itemId)
    confirm.closeConfirm()
  }, [confirm, deletePersonaMut, deleteDocMut])

  const handleSavePersona = useCallback(() => {
    const persona = selection.editingPersona
    if (persona) updatePersonaMut.mutate({
      personaId: persona.persona_id,
      updates: persona,
    })
  }, [selection.editingPersona, updatePersonaMut])

  const handleSaveDocument = useCallback(() => {
    if (docModal.editingDoc) {
      const managedTitle = docModal.editingDoc.document_type === 'prd'
        || docModal.editingDoc.document_type === 'prfaq'
      updateDocMut.mutate(
        {
          docId: docModal.editingDoc.document_id,
          ...(managedTitle ? {} : { title: docModal.newDocTitle }),
          content: docModal.newDocContent,
        },
        { onSuccess: docModal.resetAfterSave },
      )
    } else {
      createDocMut.mutate(
        {
          title: docModal.newDocTitle,
          content: docModal.newDocContent,
        },
        { onSuccess: () => docModal.setShowDocModal(false) },
      )
    }
  }, [docModal, updateDocMut, createDocMut])

  // Loading state
  if (Boolean(isLoading)) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-blue-600" size={32} />
      </div>
    )
  }

  // Not found state
  if (data?.project == null) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{t('notFound.message')}</p>
        <button
          onClick={() => {
            void navigate('/projects')
          }}
          className="mt-4 text-blue-600 hover:underline"
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

  return (
    <div className="space-y-6">
      <ProjectHeader
        name={project.name}
        description={project.description}
        onBack={() => {
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
        onContextChange={wizard.setContextConfig}
        onPersonaConfigChange={wizard.setPersonaConfig}
        onResearchConfigChange={wizard.setResearchConfig}
        onDocConfigChange={wizard.setDocConfig}
        onMergeConfigChange={wizard.setMergeConfig}
        onClose={wizard.resetWizard}
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
      />

      {/* Background jobs are visible regardless of which tab is active */}
      <JobsSection jobs={jobs} onDismiss={(jobId: string) => dismissJobMut.mutate(jobId)} />

      <TabContent
        activeTab={activeTab}
        project={project}
        personas={personas}
        documents={documents}
        productContext={productContext}
        productDocs={productDocs}
        selectedPersona={selection.selectedPersona}
        selectedDoc={selection.selectedDoc}
        isDeleting={deletePersonaMut.isPending || deleteDocMut.isPending}
        isSavingNotes={updatePersonaMut.isPending}
        onGeneratePersonas={() => wizard.setActiveWizard('persona')}
        onGenerateDoc={() => wizard.setActiveWizard('doc')}
        onRunResearch={() => wizard.openResearchWizard(personas.map((p) => p.persona_id))}
        onRemixDocuments={wizard.openMergeWizard}
        onOpenProductTool={() => setActiveTab('product')}
        onSaveKiroPrompt={handleSaveKiroPrompt}
        onSelectPersona={selection.setSelectedPersona}
        onEditPersona={() => selection.selectedPersona && selection.setEditingPersona(selection.selectedPersona)}
        onDeletePersona={() => selection.selectedPersona && confirm.openPersonaConfirm(selection.selectedPersona.persona_id)}
        onSaveNotes={saveNotes}
        onImportPersona={() => importModal.setShowImportModal(true)}
        onSelectDoc={selection.setSelectedDoc}
        onEditDoc={() => selection.selectedDoc && docModal.openEditModal(selection.selectedDoc)}
        onDeleteDoc={() => selection.selectedDoc && confirm.openDocumentConfirm(selection.selectedDoc.document_id)}
        onCreateDoc={docModal.openCreateModal}
        onSaveAsDocument={docModal.openSaveAsModal}
        onContextSaved={handleContextSaved}
        onDocumentChanged={() => {
          void queryClient.invalidateQueries({ queryKey: projectKey(id) })
        }}
        onJobStarted={handleJobStarted}
      />

      <PersonaEditModalWrapper
        editingPersona={selection.editingPersona}
        isSaving={updatePersonaMut.isPending}
        onChange={selection.setEditingPersona}
        onSave={handleSavePersona}
        onClose={() => selection.setEditingPersona(null)}
      />

      <ImportPersonaModalWrapper
        showModal={importModal.showImportModal}
        importType={importModal.importType}
        importContent={importModal.importContent}
        importFileName={importModal.importFileName}
        importMediaType={importModal.importMediaType}
        isImporting={importPersonaMut.isPending}
        onTypeChange={importModal.handleTypeChange}
        onContentChange={importModal.setImportContent}
        onFileChange={importModal.handleFileChange}
        onClose={importModal.closeModal}
        onImport={handleImportPersona}
      />

      <DocumentModalWrapper
        showModal={docModal.showDocModal}
        editingDoc={docModal.editingDoc}
        title={docModal.newDocTitle}
        content={docModal.newDocContent}
        isSaving={docModal.editingDoc ? updateDocMut.isPending : createDocMut.isPending}
        onTitleChange={docModal.setNewDocTitle}
        onContentChange={docModal.setNewDocContent}
        onSave={handleSaveDocument}
        onClose={docModal.closeModal}
      />

      <ConfirmModalWrapper
        type={confirm.confirmModal.type}
        onConfirm={handleConfirmDelete}
        onCancel={confirm.closeConfirm}
      />
    </div>
  )
}
