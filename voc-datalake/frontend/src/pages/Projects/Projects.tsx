/**
 * @fileoverview Research projects list page.
 *
 * Features:
 * - Create, view, edit (name, description, visibility) and delete research projects
 * - Project cards showing persona and document counts
 * - Navigation to project detail view
 *
 * @module pages/Projects
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import { Plus, Briefcase } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DialogClose from '../../components/DialogClose/DialogClose'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import ModalShell from '../../components/ModalShell/ModalShell'
import VisibilityChoice from '../../components/VisibilityChoice/VisibilityChoice'
import { useConfigStore } from '../../store/configStore'
import EditProjectModal from './EditProjectModal'
import { ProjectCard, ProjectsLoadingSkeleton } from './ProjectCard'
import ProjectFormFields from './ProjectFormFields'
import ProjectListControls from './ProjectListControls'
import { viewProjects } from './projectListFilter'
import type { ProjectListView } from './projectListFilter'
import type { CreateProjectBody, Project } from '../../api/projectTypes'

interface CreateProjectModalProps {
  readonly isOpen: boolean
  readonly value: NewProjectDraft
  readonly isPending: boolean
  readonly onChange: (value: NewProjectDraft) => void
  readonly onCancel: () => void
  readonly onCreate: () => void
}

function CreateProjectModal({
  isOpen, value, isPending, onChange, onCancel, onCreate,
}: CreateProjectModalProps) {
  const { t } = useTranslation('projects')
  const titleId = useId()
  const canCreate = value.name.trim() !== '' && !isPending
  return (
    <ModalShell isOpen={isOpen} onClose={onCancel} ariaLabelledBy={titleId} panelClassName="sm:max-w-md max-h-[90vh]">
      <form
        className="flex flex-col min-h-0"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCreate) onCreate()
        }}
      >
        <div className="dialog-header justify-between">
          <h2 id={titleId} className="dialog-title">{t('createModal.title')}</h2>
          <DialogClose onClick={onCancel} />
        </div>
        <div className="dialog-body space-y-4">
          <ProjectFormFields
            name={value.name}
            description={value.description}
            onNameChange={(name) => onChange({ ...value, name })}
            onDescriptionChange={(description) => onChange({ ...value, description })}
          />
          <VisibilityChoice
            value={value.visibility}
            onChange={(visibility) => onChange({
              ...value,
              visibility,
            })}
          />
        </div>
        <div className="dialog-footer flex-col-reverse sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-secondary w-full sm:w-auto"
          >
            {t('createModal.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="btn btn-primary w-full sm:w-auto"
          >
            {isPending ? t('createModal.creating') : t('createModal.create')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

interface EmptyStateProps { onCreateClick: () => void }

function EmptyState({ onCreateClick }: Readonly<EmptyStateProps>) {
  const { t } = useTranslation('projects')
  return (
    <div className="card text-center py-12 sm:py-16">
      <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-accent-subtle flex items-center justify-center">
        <Briefcase size={20} className="text-accent-text" aria-hidden />
      </div>
      <h2 className="text-base font-semibold tracking-tight text-text-strong mb-1">{t('emptyState.title')}</h2>
      <p className="text-sm text-muted mb-5 px-4">{t('emptyState.description')}</p>
      <button
        onClick={onCreateClick}
        className="btn btn-secondary"
      >
        <Plus size={16} aria-hidden />
        {t('emptyState.createButton')}
      </button>
    </div>
  )
}

/** The create form's state: every field the form edits, always present. */
type NewProjectDraft = Required<Pick<CreateProjectBody, 'name' | 'description' | 'visibility'>>

/** New projects default to private, matching the server's default. */
const EMPTY_NEW_PROJECT: NewProjectDraft = {
  name: '',
  description: '',
  visibility: 'private',
}

/** Every project the caller can see, most recently updated first. */
const DEFAULT_VIEW: ProjectListView = { q: '', scope: 'all', sort: 'updated' }

export default function Projects() {
  const { t } = useTranslation('projects')
  const { config } = useConfigStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newProject, setNewProject] = useState<NewProjectDraft>(EMPTY_NEW_PROJECT)
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  const {
    data, isLoading, isError, isFetching, refetch,
  } = useQuery({
    queryKey: projectsKey(),
    queryFn: () => projectsApi.getProjects(),
    enabled: config.apiEndpoint.length > 0,
  })
  // The confirmation names what it deletes; generic only when the project has no name.
  const deleteName = data?.projects.find((p) => p.project_id === deleteProjectId)?.name.trim() ?? ''
  const [view, setView] = useState<ProjectListView>(DEFAULT_VIEW)
  const shown = useMemo(() => viewProjects(data?.projects ?? [], view), [data, view])

  const createMutation = useMutation({
    mutationFn: (projectData: CreateProjectBody) => projectsApi.createProject(projectData),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsKey() })
      setShowCreate(false)
      setNewProject(EMPTY_NEW_PROJECT)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => projectsApi.deleteProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsKey() })
    },
  })

  const handleCreate = () => {
    if (newProject.name.trim() !== '') {
      createMutation.mutate(newProject)
    }
  }

  if (config.apiEndpoint === '') {
    return (
      <div className="card text-center py-12">
        <p className="text-sm text-muted">{t('configureEndpoint')}</p>
      </div>
    )
  }

  const renderProjectsContent = () => {
    if (isLoading) {
      return <ProjectsLoadingSkeleton />
    }

    // A failed read is not "no projects": without this the empty state invited
    // the user to create their first project whenever the API was unreachable.
    if (isError && data == null) {
      return <LoadFailed onRetry={() => void refetch()} retrying={isFetching} />
    }

    if (data == null || data.projects.length === 0) {
      return <EmptyState onCreateClick={() => setShowCreate(true)} />
    }

    return (
      <div className="space-y-3 sm:space-y-4">
        <ProjectListControls view={view} onChange={setView} />
        {shown.length === 0 ? (
          <div className="card text-center py-10 space-y-2">
            <p className="text-sm text-muted">{view.q.trim() === '' ? t('list.noneInScope') : t('list.noMatch', { q: view.q.trim() })}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setView(DEFAULT_VIEW)}>{t('list.showAll')}</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {shown.map((project) => (
              <ProjectCard
                key={project.project_id}
                project={project}
                onDelete={setDeleteProjectId}
                onEdit={setEditingProject}
                onOpen={(id) => {
                  void navigate(`/projects/${id}`)
                }}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('title')}</h1>
          <p className="text-sm text-muted mt-1 max-w-prose">{t('description')}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn btn-primary w-full sm:w-auto flex-shrink-0"
        >
          <Plus size={16} aria-hidden />
          {t('newProject')}
        </button>
      </div>

      <CreateProjectModal
        isOpen={showCreate}
        value={newProject}
        isPending={createMutation.isPending}
        onChange={setNewProject}
        onCancel={() => setShowCreate(false)}
        onCreate={handleCreate}
      />

      {renderProjectsContent()}

      {editingProject === null ? null : (
        <EditProjectModal key={editingProject.project_id} project={editingProject} onClose={() => setEditingProject(null)} />
      )}

      <ConfirmModal
        isOpen={deleteProjectId !== null}
        title={t('deleteModal.title')}
        message={deleteName === '' ? t('deleteModal.message') : t('deleteModal.messageNamed', { name: deleteName })}
        confirmLabel={t('deleteModal.confirm')}
        variant="danger"
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteProjectId != null && deleteProjectId !== '') {
            deleteMutation.mutate(deleteProjectId, { onSettled: () => setDeleteProjectId(null) })
          }
        }}
        onCancel={() => setDeleteProjectId(null)}
      />
    </div>
  )
}
