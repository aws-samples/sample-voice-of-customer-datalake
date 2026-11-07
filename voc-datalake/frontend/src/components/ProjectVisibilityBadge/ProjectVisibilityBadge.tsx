/**
 * @fileoverview Lock / Globe pill naming a project's visibility.
 *
 * A missing visibility renders as Public: that is the legacy behaviour the API
 * applies to records written before per-project permissions existed.
 *
 * @module components/ProjectVisibilityBadge
 */
import { Globe, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectVisibility } from '../../api/projectTypes'
import { IconBadge } from '../IconBadge/IconBadge'

interface ProjectVisibilityBadgeProps {
  readonly visibility?: ProjectVisibility
}

export default function ProjectVisibilityBadge({ visibility }: ProjectVisibilityBadgeProps) {
  const { t } = useTranslation('projects')
  const isPrivate = visibility === 'private'
  // Tone by meaning: Private is the restricted default, so it stays neutral
  // (badge-muted); Public widens access to the whole workspace, which is worth
  // noticing but not a warning (badge-info). The Lock/Globe icon and the text
  // carry the meaning, so colour is never the only signal.
  return (
    <IconBadge
      data-testid="project-visibility-badge"
      data-visibility={isPrivate ? 'private' : 'public'}
      toneClass={isPrivate ? 'badge-muted' : 'badge-info'}
      icon={isPrivate ? Lock : Globe}
      className="flex-shrink-0"
    >
      {isPrivate ? t('visibility.private') : t('visibility.public')}
    </IconBadge>
  )
}
