/**
 * @fileoverview The account menu at the top right of the header: an avatar
 * button (the user's initials) that opens a WAI-ARIA menu with who is signed
 * in (name, email, an "Administrator" badge for admins), "My profile"
 * (→ /account, where language, password and preferences live) and "Sign out".
 *
 * The theme switch stays a separate header button next to it (one click, and
 * already there); language stays on My profile.
 *
 * @module components/ProfileMenu
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { LogOut, UserRound } from 'lucide-react'
import { useMenuButton } from './useMenuButton'

interface ProfileUser {
  readonly name?: string
  readonly email?: string
  readonly username?: string
}

/** The best label for the user: name, then email, then username. */
function profileDisplayName(user: ProfileUser): string {
  if (user.name != null && user.name.trim() !== '') return user.name.trim()
  if (user.email != null && user.email !== '') return user.email
  return user.username ?? ''
}

/** Up to two initials ("E2E admin" → "EA", "alex@example.com" → "A"); "?" when nothing usable. */
function profileInitials(user: ProfileUser): string {
  const name = user.name?.trim() ?? ''
  const words = name === '' ? [user.email ?? user.username ?? ''] : name.split(/\s+/)
  const letters = words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('')
  return letters === '' ? '?' : letters
}

const MENU_ITEM_CLASS = 'menu-item text-sm py-2.5 sm:py-2'

export default function ProfileMenu({ user, isAdmin, onSignOut }: Readonly<{
  user: ProfileUser
  isAdmin: boolean
  onSignOut: () => void
}>) {
  const { t } = useTranslation()
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown } = useMenuButton()
  const menuId = useId()
  const name = profileDisplayName(user)
  const showEmail = user.email != null && user.email !== '' && user.email !== name
  const label = t('profileMenu.trigger', { name })

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        onKeyDown={onButtonKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        className="header-icon-btn focus-ring bg-card text-accent-text text-[0.8125rem] font-bold"
      >
        <span aria-hidden="true">{profileInitials(user)}</span>
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          aria-orientation="vertical"
          onKeyDown={onMenuKeyDown}
          className="menu absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)]"
        >
          <div className="px-3 py-2" role="presentation">
            <p className="text-sm font-semibold text-text-strong break-words">{name}</p>
            {showEmail ? <p className="text-[0.75rem] text-muted break-words [overflow-wrap:anywhere]">{user.email}</p> : null}
            {isAdmin ? <span className="badge badge-accent mt-1.5">{t('profileMenu.admin')}</span> : null}
          </div>
          <hr className="menu-separator border-0" />
          <Link to="/account" role="menuitem" className={MENU_ITEM_CLASS} onClick={() => close()}>
            <UserRound size={16} className="flex-shrink-0" aria-hidden="true" />
            <span>{t('profileMenu.myProfile')}</span>
          </Link>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM_CLASS}
            onClick={() => {
              close()
              onSignOut()
            }}
          >
            <LogOut size={16} className="flex-shrink-0" aria-hidden="true" />
            <span>{t('profileMenu.signOut')}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
