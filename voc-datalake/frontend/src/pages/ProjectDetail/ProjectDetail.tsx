/**
 * @fileoverview Project detail page with personas, documents, and chat.
 * Split into multiple components for maintainability.
 */
import { useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'

// Local components
import type { Tab } from './types'
import { useProjectData, useProjectMutations, usePersonaMutations, useDocumentMutations } from './useProjectData'
import { useWizardState } from './useWizardState'
import { useSelectionState, useDocModalState, useImportModalState, useConfirmModalState } from './useModalState'
import ProjectHeader from './ProjectHeader'
import ProjectTabs from './ProjectTabs'
import WizardSection from './WizardSection'
import TabContent from './TabContent'
import { PersonaEditModalWrapper, ImportPersonaModalWrapper, DocumentModalWrapper, ConfirmModalWrapper } from './ProjectModals'

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { config } = useConfigStore()
  
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  // Custom hooks for state management
  const wizard = useWizardState()
  const selection = useSelectionState()
  const docModal = useDocModalState()
  const importModal = useImportModalState()
  const confirm = useConfirmModalState()

  // Data fetching
  const { data, isLoading, jobsData, queryClient } = useProjectData({ id, apiEndpoint: config.apiEndpoint })

  // Mutations
  const { personaMut, docMut, resMut, mergeMut, dismissJobMut } = useProjectMutations({
    id,
    contextConfig: wizard.contextConfig,
    personaConfig: wizard.personaConfig,
    researchConfig: wizard.researchConfig,
    docConfig: wizard.docConfig,
    mergeConfig: wizard.mergeConfig,
    onSuccess: wizard.resetWizard,
    onError: () => wizard.setGenerating(null),
  })

  const { updatePersonaMut, deletePersonaMut, importPersonaMut, saveNotes } = usePersonaMutations({
    id,
    selectedPersona: selection.selectedPersona,
    editingPersona: selection.editingPersona,
    setEditingPersona: selection.setEditingPersona,
    setSelectedPersona: selection.setSelectedPersona,
  })

  const { createDocMut, deleteDocMut, updateDocMut } = useDocumentMutations({
    id,
    selectedDoc: selection.selectedDoc,
    setSelectedDoc: selection.setSelectedDoc,
  })

  // Handlers
  const handleImportPersona = useCallback(() => {
    importPersonaMut.mutate(
      { input_type: importModal.importType, content: importModal.importContent, media_type: importModal.importMediaType },
      { onSuccess: importModal.closeModal }
    )
  }, [importPersonaMut, importModal])

  const handleSaveKiroPrompt = useCallback((prompt: string) => {
    const project = data?.project
    if (!project) return
    void api.updateProject(project.project_id, { kiro_export_prompt: prompt })
      .then(() => queryClient.invalidateQueries({ queryKey: ['project', id] }))
  }, [data, queryClient, id])

  const handleConfirmDelete = useCallback(() => {
    const { type, id: itemId } = confirm.confirmModal
    if (type === 'persona' && itemId) deletePersonaMut.mutate(itemId)
    else if (type === 'document' && itemId) deleteDocMut.mutate(itemId)
    confirm.closeConfirm()
  }, [confirm, deletePersonaMut, deleteDocMut])

  const handleSavePersona = useCallback(() => {
    const persona = selection.editingPersona
    if (persona) updatePersonaMut.mutate({ personaId: persona.persona_id, updates: persona })
  }, [selection.editingPersona, updatePersonaMut])

  const handleSaveDocument = useCallback(() => {
    if (docModal.editingDoc) {
      updateDocMut.mutate(
        { docId: docModal.editingDoc.document_id, title: docModal.newDocTitle, content: docModal.newDocContent },
        { onSuccess: docModal.resetAfterSave }
      )
    } else {
      createDocMut.mutate(
        { title: docModal.newDocTitle, content: docModal.newDocContent },
        { onSuccess: () => docModal.setShowDocModal(false) }
      )
    }
  }, [docModal, updateDocMut, createDocMut])

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-blue-600" size={32} />
      </div>
    )
  }

  // Not found state
  if (!data?.project) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Project not found</p>
        <button onClick={() => navigate('/projects')} className="mt-4 text-blue-600 hover:underline">
          Back to Projects
        </button>
      </div>
    )
  }

  const { project, personas, documents } = data
  const jobs = jobsData?.jobs ?? []

  return (
    <div className="space-y-6">
      <ProjectHeader name={project.name} description={project.description} onBack={() => navigate('/projects')} />
      <ProjectTabs activeTab={activeTab} personasCount={personas.length} documentsCount={documents.length} onTabChange={setActiveTab} />

      <WizardSection
        activeWizard={wizard.activeWizard}
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
        onSubmitPersona={() => { wizard.setGenerating('personas'); personaMut.mutate() }}
        onSubmitResearch={() => { wizard.setGenerating('research'); resMut.mutate() }}
        onSubmitDoc={() => { wizard.setGenerating('doc'); docMut.mutate() }}
        onSubmitMerge={() => { wizard.setGenerating('merge'); mergeMut.mutate() }}
      />

      <TabContent
        activeTab={activeTab}
        project={project}
        personas={personas}
        documents={documents}
        jobs={jobs}
        selectedPersona={selection.selectedPersona}
        selectedDoc={selection.selectedDoc}
        isDeleting={deletePersonaMut.isPending || deleteDocMut.isPending}
        isSavingNotes={updatePersonaMut.isPending}
        onGeneratePersonas={() => wizard.setActiveWizard('persona')}
        onGenerateDoc={() => wizard.setActiveWizard('doc')}
        onRunResearch={() => wizard.setActiveWizard('research')}
        onRemixDocuments={wizard.openMergeWizard}
        onDismissJob={(jobId) => dismissJobMut.mutate(jobId)}
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
        onDocumentChanged={() => void queryClient.invalidateQueries({ queryKey: ['project', id] })}
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
