/**
 * @fileoverview Lock / Globe pill naming a project's visibility.
 *
 * A missing visibility renders as Public: that is the legacy behaviour the API
 * applies to records written before per-project permissions existed.
 *
 * @module components/ProjectVisibilityBadge
 */
import clsx from 'clsx'
import { Globe, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectVisibility } from '../../api/projectTypes'

interface ProjectVisibilityBadgeProps {
  readonly visibility?: ProjectVisibility
  readonly className?: string
}

export default function ProjectVisibilityBadge({
  visibility, className,
}: ProjectVisibilityBadgeProps) {
  const { t } = useTranslation('projects')
  const isPrivate = visibility === 'private'
  const Icon = isPrivate ? Lock : Globe
  return (
    <span
      data-testid="project-visibility-badge"
      data-visibility={isPrivate ? 'private' : 'public'}
      // Tone by meaning: Private is the restricted default, so it stays neutral
      // (badge-muted); Public widens access to the whole workspace, which is worth
      // noticing but not a warning (badge-info). The Lock/Globe icon and the text
      // carry the meaning, so colour is never the only signal.
      className={clsx(
        'badge inline-flex items-center gap-1 flex-shrink-0',
        isPrivate ? 'badge-muted' : 'badge-info',
        className,
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {isPrivate ? t('visibility.private') : t('visibility.public')}
    </span>
  )
}
