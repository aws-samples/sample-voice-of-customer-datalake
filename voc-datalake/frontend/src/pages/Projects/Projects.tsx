/**
 * @fileoverview Research projects list page.
 *
 * Features:
 * - Create, view, and delete research projects
 * - Project cards showing persona and document counts
 * - Navigation to project detail view
 *
 * @module pages/Projects
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  Plus, Briefcase, Users, FileText, Trash2, ArrowRight,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { projectsApi } from '../../api/projectsApi'
import ConfirmModal from '../../components/ConfirmModal'
import { useConfigStore } from '../../store/configStore'
import type { Project } from '../../api/types'

interface ProjectCardProps {
  project: Project
  onDelete: (id: string) => void
  onOpen: (id: string) => void
}

function ProjectCard({
  project, onDelete, onOpen,
}: Readonly<ProjectCardProps>) {
  const { t } = useTranslation('projects')
  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-9 h-9 sm:w-10 sm:h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <Briefcase size={18} className="text-blue-600 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 text-sm sm:text-base truncate">{project.name}</h3>
            <p className="text-xs text-gray-500">
              {format(new Date(project.created_at), 'MMM d, yyyy')}
            </p>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete(project.project_id)
          }}
          className="p-1.5 text-gray-400 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
        >
          <Trash2 size={16} />
        </button>
      </div>

      {project.description === '' ? null : <p className="text-xs sm:text-sm text-gray-600 mb-3 sm:mb-4 line-clamp-2">{project.description}</p>}

      <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm text-gray-500 mb-3 sm:mb-4">
        <span className="flex items-center gap-1">
          <Users size={14} />
          {t('card.personas', { count: project.persona_count })}
        </span>
        <span className="flex items-center gap-1">
          <FileText size={14} />
          {t('card.docs', { count: project.document_count })}
        </span>
      </div>

      <button
        onClick={() => onOpen(project.project_id)}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-50 text-gray-700 rounded-lg hover:bg-blue-50 hover:text-blue-600 transition-colors text-sm"
      >
        {t('openProject')}
        <ArrowRight size={16} />
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl p-4 sm:p-6 border border-gray-200 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-3/4 mb-2" />
          <div className="h-4 bg-gray-100 rounded w-full mb-4" />
          <div className="h-4 bg-gray-100 rounded w-1/2" />
        </div>
      ))}
    </div>
  )
}

interface EmptyStateProps { onCreateClick: () => void }

function EmptyState({ onCreateClick }: Readonly<EmptyStateProps>) {
  const { t } = useTranslation('projects')
  return (
    <div className="text-center py-12 sm:py-16 bg-white rounded-xl border border-gray-200">
      <Briefcase size={40} className="mx-auto text-gray-300 mb-4 sm:w-12 sm:h-12" />
      <h3 className="text-base sm:text-lg font-medium text-gray-900 mb-2">{t('emptyState.title')}</h3>
      <p className="text-sm sm:text-base text-gray-500 mb-4 px-4">{t('emptyState.description')}</p>
      <button
        onClick={onCreateClick}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
      >
        <Plus size={18} />
        {t('emptyState.createButton')}
      </button>
    </div>
  )
}

export default function Projects() {
  const { t } = useTranslation('projects')
  const { config } = useConfigStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newProject, setNewProject] = useState({
    name: '',
    description: '',
  })
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null)

  const {
    data, isLoading,
  } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsApi.getProjects(),
    enabled: config.apiEndpoint.length > 0,
  })

  const createMutation = useMutation({
    mutationFn: (projectData: {
      name: string;
      description: string
    }) => projectsApi.createProject(projectData),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowCreate(false)
      setNewProject({
        name: '',
        description: '',
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => projectsApi.deleteProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const handleCreate = () => {
    if (newProject.name.trim() !== '') {
      createMutation.mutate(newProject)
    }
  }

  if (config.apiEndpoint === '') {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{t('configureEndpoint')}</p>
      </div>
    )
  }

  const renderProjectsContent = () => {
    if (isLoading) {
      return <LoadingSkeleton />
    }

    if (data?.projects.length == null) {
      return <EmptyState onCreateClick={() => setShowCreate(true)} />
    }

    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {data.projects.map((project) => (
          <ProjectCard
            key={project.project_id}
            project={project}
            onDelete={setDeleteProjectId}
            onOpen={(id) => {
              void navigate(`/projects/${id}`)
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm sm:text-base text-gray-500 mt-1">{t('description')}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 w-full sm:w-auto"
        >
          <Plus size={18} />
          {t('newProject')}
        </button>
      </div>

      {showCreate ? <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
        <div className="bg-white rounded-t-xl sm:rounded-xl p-4 sm:p-6 w-full sm:max-w-md max-h-[90vh] overflow-y-auto">
          <h2 className="text-lg font-semibold mb-4">{t('createModal.title')}</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('createModal.nameLabel')}</label>
              <input
                type="text"
                value={newProject.name}
                onChange={(e) => setNewProject({
                  ...newProject,
                  name: e.target.value,
                })}
                placeholder={t('createModal.namePlaceholder')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('createModal.descriptionLabel')}</label>
              <textarea
                value={newProject.description}
                onChange={(e) => setNewProject({
                  ...newProject,
                  description: e.target.value,
                })}
                placeholder={t('createModal.descriptionPlaceholder')}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 mt-6">
            <button
              onClick={() => setShowCreate(false)}
              className="w-full sm:w-auto px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              {t('createModal.cancel')}
            </button>
            <button
              onClick={handleCreate}
              disabled={newProject.name.trim() === '' || createMutation.isPending}
              className="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {createMutation.isPending ? t('createModal.creating') : t('createModal.create')}
            </button>
          </div>
        </div>
      </div> : null}

      {renderProjectsContent()}

      <ConfirmModal
        isOpen={deleteProjectId !== null}
        title={t('deleteModal.title')}
        message={t('deleteModal.message')}
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
