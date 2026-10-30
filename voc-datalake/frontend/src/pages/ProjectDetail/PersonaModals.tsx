/**
 * The persona edit and import modals, wired to the shared persona state hooks. Used by
 * the project page and the company persona library (5.60), so both open, save and
 * import the same way.
 */
import { ImportPersonaModalWrapper, PersonaEditModalWrapper } from './ProjectModals'
import type { useImportModalState, useSelectionState } from './useModalState'
import type { usePersonaMutations } from './usePersonaMutations'

interface PersonaModalsProps {
  readonly selection: ReturnType<typeof useSelectionState>
  readonly importModal: ReturnType<typeof useImportModalState>
  readonly mutations: Pick<ReturnType<typeof usePersonaMutations>, 'updatePersonaMut' | 'importPersonaMut' | 'saveEditingPersona'>
  /** After an import job started (the modal has closed); e.g. keep the jobs poll alive. */
  readonly onImportStarted?: () => void
}

export default function PersonaModals({ selection, importModal, mutations, onImportStarted }: PersonaModalsProps) {
  const runImport = () => {
    mutations.importPersonaMut.mutate(
      { input_type: importModal.importType, content: importModal.importContent, media_type: importModal.importMediaType },
      { onSuccess: () => { importModal.closeModal(); onImportStarted?.() } },
    )
  }
  return (
    <>
      <PersonaEditModalWrapper
        editingPersona={selection.editingPersona}
        isSaving={mutations.updatePersonaMut.isPending}
        onChange={selection.setEditingPersona}
        onSave={mutations.saveEditingPersona}
        onClose={() => selection.setEditingPersona(null)}
      />
      <ImportPersonaModalWrapper
        showModal={importModal.showImportModal}
        importType={importModal.importType}
        importContent={importModal.importContent}
        importFileName={importModal.importFileName}
        isImporting={mutations.importPersonaMut.isPending}
        onTypeChange={importModal.handleTypeChange}
        onContentChange={importModal.setImportContent}
        onFileChange={importModal.handleFileChange}
        onClose={importModal.closeModal}
        onImport={runImport}
      />
    </>
  )
}
