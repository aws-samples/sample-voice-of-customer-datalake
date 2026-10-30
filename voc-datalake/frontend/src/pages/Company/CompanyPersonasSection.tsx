/**
 * @fileoverview Knowledge → Company → Personas (5.60): the company persona library.
 *
 * Reuses the project persona UI (list + detail, edit, import, generate wizard, notes,
 * avatar, delete) through `PersonaScope` = company. Admins write (`can_edit` from the
 * list); everyone else reads. Generation only ever adds to the library. Projects copy
 * personas in from here, and admins promote project personas into it; every copy is
 * independent and never carries research notes. The assistant stays project-scoped.
 *
 * @module pages/Company/CompanyPersonasSection
 */
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import JobsBadge from '../ProjectDetail/JobsBadge'
import PersonasTab from '../ProjectDetail/PersonasTab'
import PersonasEmptyCard from '../ProjectDetail/PersonasEmptyCard'
import PersonaModals from '../ProjectDetail/PersonaModals'
import { ConfirmModalWrapper } from '../ProjectDetail/ProjectModals'
import { PersonaWizard } from '../ProjectDetail/Wizards'
import { COMPANY_PERSONA_SCOPE } from '../ProjectDetail/personaScope'
import { personaListHandlers, useConfirmModalState, useImportModalState, useSelectionState } from '../ProjectDetail/useModalState'
import { usePersonaMutations } from '../ProjectDetail/usePersonaMutations'
import { useProjectWizardState } from '../ProjectDetail/useProjectWizardState'
import { useCompanyPersonas } from './useCompanyPersonas'
import type { ProjectDocument } from '../../api/types'

/** The persona generator reads feedback only; the wizard's document pickers stay empty. */
const NO_DOCUMENTS: ProjectDocument[] = []

function LibraryEmptyState({ canEdit }: Readonly<{ canEdit: boolean }>) {
  const { t } = useTranslation('settings')
  return (
    <PersonasEmptyCard title={t('company.personas.emptyTitle')} body={t('company.personas.emptyBody')}>
      <p className="text-sm text-muted max-w-prose mx-auto">
        {canEdit ? t('company.personas.emptyHowAdmin') : t('company.personas.emptyHowReader')}
      </p>
    </PersonasEmptyCard>
  )
}

export default function CompanyPersonasSection() {
  const { t } = useTranslation('settings')
  const library = useCompanyPersonas()
  const wizard = useProjectWizardState()
  const selection = useSelectionState()
  const importModal = useImportModalState()
  const confirm = useConfirmModalState()
  const personaMutations = usePersonaMutations({
    scope: COMPANY_PERSONA_SCOPE,
    selectedPersona: selection.selectedPersona,
    editingPersona: selection.editingPersona,
    setEditingPersona: selection.setEditingPersona,
    setSelectedPersona: selection.setSelectedPersona,
  })
  const { updatePersonaMut, deletePersonaMut, saveNotes } = personaMutations
  const { canEdit } = library

  const handleConfirmDelete = () => {
    const personaId = confirm.confirmModal.id
    if (confirm.confirmModal.type === 'persona' && personaId != null && personaId !== '') deletePersonaMut.mutate(personaId)
    confirm.closeConfirm()
  }

  const closeWizard = () => { library.generate.reset(); wizard.resetWizard() }
  const submitWizard = () => {
    wizard.setGenerating('personas')
    library.generate.mutate(
      { contextConfig: wizard.contextConfig, personaConfig: wizard.personaConfig },
      { onSuccess: wizard.resetWizard, onError: () => wizard.setGenerating(null) },
    )
  }

  if (library.isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="animate-spin text-accent" size={24} aria-label={t('company.personas.loading')} /></div>
  }
  if (library.loadFailed) {
    return <div role="alert" className="card text-sm text-danger">{t('company.personas.loadFailed')}</div>
  }

  return (
    <section className="space-y-4" aria-label={t('company.tabs.personas')}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <p className="text-sm text-muted max-w-prose">{t('company.personas.intro')}</p>
        <JobsBadge jobs={library.jobs} />
      </div>

      {wizard.activeWizard === 'persona' ? (
        <PersonaWizard
          additiveOnly
          personas={library.personas}
          documents={NO_DOCUMENTS}
          contextConfig={wizard.contextConfig}
          personaConfig={wizard.personaConfig}
          generating={wizard.generating}
          startError={library.generate.error}
          onContextChange={wizard.setContextConfig}
          onPersonaConfigChange={wizard.setPersonaConfig}
          onClose={closeWizard}
          onSubmit={submitWizard}
        />
      ) : null}

      <PersonasTab
        scope={COMPANY_PERSONA_SCOPE}
        personas={library.personas}
        canEdit={canEdit}
        selectedPersona={selection.selectedPersona}
        {...personaListHandlers(selection, confirm)}
        onSaveNotes={saveNotes}
        onGeneratePersonas={() => wizard.setActiveWizard('persona')}
        onImportPersona={() => importModal.setShowImportModal(true)}
        emptyState={<LibraryEmptyState canEdit={canEdit} />}
        isDeleting={deletePersonaMut.isPending}
        isSavingNotes={updatePersonaMut.isPending}
      />

      <PersonaModals selection={selection} importModal={importModal} mutations={personaMutations} onImportStarted={library.jobStarted} />
      <ConfirmModalWrapper type={confirm.confirmModal.type} onConfirm={handleConfirmDelete} onCancel={confirm.closeConfirm} />
    </section>
  )
}
