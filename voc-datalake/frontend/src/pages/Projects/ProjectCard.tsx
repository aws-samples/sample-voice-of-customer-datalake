/**
 * @fileoverview One project on the Projects list: name (up to two lines),
 * visibility badge in one fixed place under the name, owner, description,
 * counts, "Open project", and Edit / Delete in an always-visible "⋯" menu (only
 * the actions the caller may take; none → no menu).
 *
 * The menu closes on Escape (focus returns to its button) and on a click outside.
 *
 * @module pages/Projects/ProjectCard
 */
import { ArrowRight, Briefcase, FileText, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react'
import { useDisclosurePopover } from '../../hooks/useDismissOnOutside'
import { useTranslation } from 'react-i18next'
import { personLabel } from '../../components/ProjectSharingModal/sharingHelpers'
import ProjectVisibilityBadge from '../../components/ProjectVisibilityBadge/ProjectVisibilityBadge'
import { formatDate } from '../../utils/dateUtils'
import type { Project } from '../../api/projectTypes'

interface ProjectCardProps {
  readonly project: Project
  readonly onDelete: (id: string) => void
  readonly onEdit: (project: Project) => void
  readonly onOpen: (id: string) => void
}

function CardMenu({ project, onEdit, onDelete }: Readonly<Pick<ProjectCardProps, 'project' | 'onEdit' | 'onDelete'>>) {
  const { t } = useTranslation('projects')
  const { open, toggle, close, panelId: menuId, wrapper, trigger } = useDisclosurePopover()
  // Fail closed: the list's normaliser reads a missing access as no edit.
  const canEdit = project.access?.can_edit === true
  const canDelete = project.access?.can_manage === true
  if (!canEdit && !canDelete) return null
  const pick = (run: () => void) => () => { close(); run() }
  return (
    <div className="relative flex-shrink-0" ref={wrapper}>
      <button ref={trigger} type="button" className="icon-btn" onClick={toggle}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={t('card.actions', { name: project.name })} title={t('card.actions', { name: project.name })}>
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div id={menuId} role="menu" className="menu absolute right-0 top-full mt-1 z-20 w-48">
          {canEdit && (
            <button type="button" role="menuitem" className="menu-item" aria-haspopup="dialog" aria-label={t('card.editProject', { name: project.name })}
              onClick={pick(() => onEdit(project))}>
              <Pencil size={14} aria-hidden /> {t('card.edit')}
            </button>
          )}
          {canDelete && (
            <button type="button" role="menuitem" className="menu-item text-danger" aria-label={t('card.deleteProject', { name: project.name })}
              onClick={pick(() => onDelete(project.project_id))}>
              <Trash2 size={14} aria-hidden /> {t('card.delete')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ProjectCard({ project, onDelete, onEdit, onOpen }: ProjectCardProps) {
  const { t, i18n } = useTranslation('projects')
  const ownerName = project.owner == null ? '' : personLabel(project.owner)
  return (
    <div className="@container card stat-accent p-4 sm:p-5 flex flex-col hover:border-border-strong hover:shadow-md transition-all">
      <div className="flex items-start gap-3 mb-3">
        {/* Decorative: hidden in a narrow card (390 px / 200 % text) so the name gets the width. */}
        <div className="w-10 h-10 bg-accent-subtle rounded-lg flex items-center justify-center flex-shrink-0 @max-[16em]:hidden" data-testid="project-card-icon">
          <Briefcase size={18} className="text-accent-text" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {/* `hyphens-auto`, not `overflow-wrap:anywhere`: a word breaks at a hyphenation
              point ("Improve-ments"); `break-words` still splits a long token that can't fit. */}
          <h2 className="text-base font-semibold tracking-tight text-text-strong break-words hyphens-auto">{project.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <ProjectVisibilityBadge visibility={project.visibility} />
            <span className="text-xs text-muted">{formatDate(project.updated_at === '' ? project.created_at : project.updated_at, i18n.language)}</span>
          </div>
        </div>
        <CardMenu project={project} onEdit={onEdit} onDelete={onDelete} />
      </div>

      {ownerName === '' ? null : <p className="text-xs text-muted mb-2 truncate">{t('card.owner', { name: ownerName })}</p>}

      {project.description === '' ? null : <p className="text-sm text-text mb-4 line-clamp-2" title={project.description}>{project.description}</p>}

      <div className="flex items-center gap-4 text-xs text-muted mb-4 mt-auto">
        <span className="flex items-center gap-1.5">
          <Users size={14} aria-hidden />
          {t('card.personas', { count: project.persona_count })}
        </span>
        <span className="flex items-center gap-1.5">
          <FileText size={14} aria-hidden />
          {t('card.docs', { count: project.document_count })}
        </span>
      </div>

      <button type="button" onClick={() => onOpen(project.project_id)} className="btn btn-secondary w-full">
        {t('openProject')}
        <ArrowRight size={14} aria-hidden />
      </button>
    </div>
  )
}

export function ProjectsLoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="card p-4 sm:p-5" aria-hidden>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 skeleton rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="h-4 skeleton w-3/4" />
              <div className="h-3 skeleton w-1/3" />
            </div>
          </div>
          <div className="h-4 skeleton w-full mb-4" />
          <div className="h-9 skeleton w-full" />
        </div>
      ))}
    </div>
  )
}
