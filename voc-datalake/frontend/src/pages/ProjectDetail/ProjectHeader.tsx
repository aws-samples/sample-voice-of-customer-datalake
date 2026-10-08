/**
 * ProjectHeader - Header component for project detail page
 *
 * Page-title typography from the design system (title + `text-sm text-muted
 * mt-1` subtitle). The back arrow is icon-only, so it carries an accessible
 * name and tooltip; long names truncate with the full text in `title`.
 *
 * "Connect via MCP" replaces the removed per-project Export / MCP tab: it opens
 * the global Connect page with this project pre-selected as the token's pin.
 */
import { ArrowLeft, Bot, Plug, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import ProjectVisibilityBadge from '../../components/ProjectVisibilityBadge/ProjectVisibilityBadge'
import { useAssistantUiStore } from '../../assistant/store/assistantStore'
import type { ProjectVisibility } from '../../api/projectTypes'

interface ProjectHeaderProps {
  readonly name: string
  readonly description?: string
  readonly onBack: () => void
  /** Rendered as a badge beside the name when supplied. */
  readonly visibility?: ProjectVisibility
  /** Shows the Share button when supplied (opens the sharing dialog). */
  readonly onShare?: () => void
  /** Shows the "Connect via MCP" link (global Connect, pinned to this project) when supplied. */
  readonly projectId?: string
}

/** Opens the floating assistant, which already has this project as its context. */
function AskAssistantButton() {
  const { t } = useTranslation('assistant')
  const setOpen = useAssistantUiStore((s) => s.setOpen)
  return (
    <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary flex-shrink-0">
      <Bot size={16} aria-hidden="true" className="text-aim" />
      {t('launcher.askAboutProject')}
    </button>
  )
}

export default function ProjectHeader({
  name, description, onBack, visibility, onShare, projectId,
}: ProjectHeaderProps) {
  const { t } = useTranslation(['projectDetail', 'projects', 'common'])
  const backLabel = t('header.back')
  return (
    // Wraps below `sm`: the actions take their own row, so on a phone the title and
    // description keep the full width instead of truncating to a couple of letters.
    <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap sm:gap-3">
      <button
        type="button"
        onClick={onBack}
        className="icon-btn mt-0.5 -ml-1.5 p-2"
        aria-label={backLabel}
        title={backLabel}
      >
        <ArrowLeft size={16} aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong truncate" title={name}>{name}</h1>
          {visibility === undefined ? null : <ProjectVisibilityBadge visibility={visibility} />}
        </div>
        {description != null && description !== '' ? <p className="text-sm text-muted mt-1 line-clamp-2">{description}</p> : null}
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-shrink-0 sm:flex-nowrap">
        <AskAssistantButton />
        {onShare === undefined ? null : (
          <button
            type="button"
            onClick={onShare}
            aria-haspopup="dialog"
            className="btn btn-secondary flex-shrink-0"
          >
            <Share2 size={16} aria-hidden="true" />
            {t('projects:sharing.share')}
          </button>
        )}
        {projectId === undefined ? null : (
          <Link
            to={`/connect?project=${encodeURIComponent(projectId)}`}
            title={t('common:connect.shortcutTitle')}
            className="btn btn-secondary flex-shrink-0"
          >
            <Plug size={16} aria-hidden="true" />
            {t('header.connectMcp')}
          </Link>
        )}
      </div>
    </div>
  )
}
