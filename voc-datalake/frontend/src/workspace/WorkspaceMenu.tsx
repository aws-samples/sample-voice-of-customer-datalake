/**
 * @fileoverview The current workspace in the header (docs/multi-workspace.md): a WAI-ARIA menu button (the account
 * menu's behaviour, `useMenuButton`) named after the workspace and the caller's role there. Its menu lists the
 * caller's other workspaces, if any (not one the server refused in this tab, refusedWorkspaces.ts), then Members (`/members`, the workspace's members page). Choosing another
 * workspace is a full page load to `/w/{slug}/dashboard`, which starts with an empty cache (so once phase 2 keys the
 * data by workspace, no answer of this one is shown in the next). Nothing renders outside a workspace.
 *
 * @module workspace/WorkspaceMenu
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Building2, ChevronDown, Users } from 'lucide-react'
import { menuButtonParts, useMenuButton } from '../components/ProfileMenu/useMenuButton'
import { useCurrentWorkspace } from './currentWorkspace'
import { withoutRefused } from './refusedWorkspaces'
import { useMyWorkspaces } from './useMyWorkspaces'
import { workspaceUrl } from './workspacePath'

const NAME_CLASS = 'hidden sm:inline max-w-[12rem] truncate text-sm font-medium text-text-strong'
const ITEM_CLASS = 'menu-item text-sm py-2.5 sm:py-2'

export default function WorkspaceMenu() {
  const { t } = useTranslation()
  const current = useCurrentWorkspace()
  const { data } = useMyWorkspaces()
  const menu = useMenuButton()
  const menuId = useId()
  if (current === null) return null
  // A workspace the server refused in this tab is not offered (the gate would only answer not-found there).
  const others = withoutRefused(data ?? []).filter((workspace) => workspace.id !== current.id)

  // The current workspace and its role are in the button's and the menu's accessible name (WAI-ARIA menu
  // pattern: inside role="menu" only the menu items are announced, so the block below is visual only).
  const role = t(`workspaces.role.${current.role}`)
  const label = others.length === 0
    ? t('workspaces.menu.triggerSingle', { name: current.name, role })
    : t('workspaces.menu.trigger', { name: current.name, role })
  const parts = menuButtonParts(menu, menuId, label)
  return (
    <div className="relative flex-shrink-0">
      <button {...parts.trigger} className="header-control focus-ring flex items-center gap-2 rounded-full bg-bg-elevated px-2.5 sm:px-3">
        <Building2 size={16} className="text-accent flex-shrink-0" aria-hidden="true" />
        <span className={NAME_CLASS}>{current.name}</span>
        <ChevronDown size={14} className="text-muted flex-shrink-0" aria-hidden="true" />
      </button>

      {menu.open ? (
        <div {...parts.list} className="menu absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)]">
          <div className="px-3 py-2" aria-hidden="true">
            <p className="text-[0.75rem] text-muted">{t('workspaces.menu.current')}</p>
            <p className="text-sm font-semibold text-text-strong break-words">{current.name}</p>
            <span className="badge badge-muted mt-1.5">{role}</span>
          </div>
          {others.length > 0 ? (
            <>
              <hr className="menu-separator border-0" />
              <p className="menu-label" aria-hidden="true">{t('workspaces.menu.switchTo')}</p>
              {others.map((workspace) => (
                <a
                  key={workspace.id}
                  href={workspaceUrl(workspace.slug, '/dashboard')}
                  role="menuitem"
                  className={ITEM_CLASS}
                  onClick={() => menu.close()}
                >
                  <Building2 size={16} className="flex-shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">{workspace.name}</span>
                  <span className="text-[0.75rem] text-muted">{t(`workspaces.role.${workspace.role}`)}</span>
                </a>
              ))}
            </>
          ) : null}
          <hr className="menu-separator border-0" />
          <Link to="/members" role="menuitem" className={ITEM_CLASS} onClick={() => menu.close()}>
            <Users size={16} className="flex-shrink-0" aria-hidden="true" />
            <span>{t('workspaces.menu.members')}</span>
          </Link>
        </div>
      ) : null}
    </div>
  )
}
