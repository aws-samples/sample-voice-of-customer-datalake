/**
 * @fileoverview Edit a project from the Projects list: name, description and,
 * for a caller who may manage it, visibility.
 *
 * Mounted per project (keyed by id), so the draft always starts from the
 * project it edits. Escape and Cancel close it without a request.
 *
 * @module pages/Projects/EditProjectModal
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import VisibilityChoice from '../../components/VisibilityChoice/VisibilityChoice'
import {
  EditProjectDraftSchema, draftFrom, editsFor, hasEdits, useEditProject, type EditProjectDraft,
} from './editProject'
import ProjectFormFields from './ProjectFormFields'
import type { Project } from '../../api/projectTypes'

interface EditProjectModalProps {
  readonly project: Project
  readonly onClose: () => void
}

/** The name's validation message key, or null while it is valid. */
function nameError(draft: EditProjectDraft): string | null {
  const parsed = EditProjectDraftSchema.shape.name.safeParse(draft.name)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? null)
}

export default function EditProjectModal({ project, onClose }: EditProjectModalProps) {
  const { t } = useTranslation('projects')
  const titleId = useId()
  const [draft, setDraft] = useState<EditProjectDraft>(() => draftFrom(project))
  const canManage = project.access?.can_manage === true
  const save = useEditProject(onClose)

  const error = nameError(draft)
  const edits = editsFor(project, draft, canManage)
  const canSave = error === null && hasEdits(edits) && !save.isPending

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="sm:max-w-md max-h-[90vh]" dismissable={!save.isPending}>
      <form
        className="flex flex-col min-h-0"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) save.mutate({ projectId: project.project_id, edits })
        }}
      >
        <div className="dialog-header justify-between">
          <h2 id={titleId} className="dialog-title">{t('editModal.title')}</h2>
          <DialogClose onClick={onClose} />
        </div>
        <div className="dialog-body space-y-4">
          <ProjectFormFields
            name={draft.name}
            description={draft.description}
            onNameChange={(name) => setDraft({ ...draft, name })}
            onDescriptionChange={(description) => setDraft({ ...draft, description })}
            nameError={error === null ? null : t(error)}
          />
          {canManage
            ? <VisibilityChoice value={draft.visibility} onChange={(visibility) => setDraft({ ...draft, visibility })} disabled={save.isPending} />
            : <p className="text-xs text-muted">{t('editModal.visibilityManageOnly')}</p>}
          {save.isError ? <p role="alert" className="text-sm text-danger bg-danger-subtle p-3 rounded-lg">{t('editModal.saveFailed')}</p> : null}
        </div>
        <div className="dialog-footer flex-col-reverse sm:flex-row">
          <button type="button" onClick={onClose} disabled={save.isPending} className="btn btn-secondary w-full sm:w-auto">
            {t('createModal.cancel')}
          </button>
          <button type="submit" disabled={!canSave} className="btn btn-primary w-full sm:w-auto">
            {save.isPending ? t('editModal.saving') : t('editModal.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
