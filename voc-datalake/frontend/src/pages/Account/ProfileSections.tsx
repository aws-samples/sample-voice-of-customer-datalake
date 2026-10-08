/**
 * @fileoverview Account page sections: identity header, profile details,
 * language & theme, MCP tokens pointer, sign out.
 * @module pages/Account/ProfileSections
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Eye, LogOut, Plug, Shield, SlidersHorizontal, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ThemeToggle from '../../components/ThemeToggle/ThemeToggle'
import { changeLanguage, isSupportedLanguage, languageNames, supportedLanguages } from '../../i18n/languages'

export interface AccountUser {
  readonly name?: string
  readonly email?: string
  readonly username?: string
  readonly groups?: readonly string[]
}

function displayName(user: AccountUser): string {
  if (user.name !== undefined && user.name !== '') return user.name
  if (user.email !== undefined && user.email !== '') return user.email
  return user.username ?? ''
}

function initialOf(user: AccountUser): string {
  const initial = displayName(user).charAt(0).toUpperCase()
  return initial === '' ? 'U' : initial
}

/** A titled card; the heading labels the region for screen readers. */
export function Section({ icon: Icon, title, description, children, className }: Readonly<{
  icon: LucideIcon
  title: string
  description?: string
  children: ReactNode
  className?: string
}>) {
  const titleId = useId()
  return (
    <section className={clsx('card space-y-4', className)} aria-labelledby={titleId}>
      <div>
        <h2 id={titleId} className="text-base font-semibold text-text-strong flex items-center gap-2">
          <Icon size={16} className="text-muted" aria-hidden="true" /> {title}
        </h2>
        {description === undefined ? null : <p className="text-sm text-muted mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export function IdentityHeader({ user }: Readonly<{ user: AccountUser }>) {
  const { t } = useTranslation('common')
  const name = displayName(user)
  return (
    <div className="flex items-center gap-4 min-w-0">
      <div aria-hidden="true" className="w-14 h-14 rounded-full bg-accent-subtle text-accent-text ring-1 ring-accent/30 flex items-center justify-center text-xl font-bold flex-shrink-0">
        {initialOf(user)}
      </div>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-text-strong truncate">{t('account.title')}</h1>
        <p className="text-sm text-text truncate">{name}</p>
        <p className="text-sm text-muted mt-0.5">{t('account.subtitle')}</p>
      </div>
    </div>
  )
}

function ProfileRow({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-text-strong truncate mt-0.5">{children}</dd>
    </div>
  )
}

function orDash(value: string | undefined): string {
  return value === undefined || value === '' ? '—' : value
}

function RoleValue({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('common')
  const Icon = isAdmin ? Shield : Eye
  return (
    <span className={clsx('inline-flex items-center gap-1.5', isAdmin ? 'text-aim font-medium' : 'text-text')}>
      <Icon size={14} aria-hidden="true" /> {isAdmin ? t('account.roleAdmin') : t('account.roleUser')}
    </span>
  )
}

export function ProfileDetails({ user, isAdmin }: Readonly<{ user: AccountUser; isAdmin: boolean }>) {
  const { t } = useTranslation('common')
  const groups = user.groups ?? []
  return (
    <Section icon={UserRound} title={t('account.profile')}>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <ProfileRow label={t('account.name')}>{orDash(user.name)}</ProfileRow>
        <ProfileRow label={t('account.email')}>{orDash(user.email)}</ProfileRow>
        <ProfileRow label={t('account.username')}>{orDash(user.username)}</ProfileRow>
        <ProfileRow label={t('account.role')}><RoleValue isAdmin={isAdmin} /></ProfileRow>
        {groups.length === 0 ? null : (
          <ProfileRow label={t('account.groups')}>
            <ul className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <li key={group} className={clsx('badge', group === 'admins' ? 'badge-aim' : 'badge-muted')}>{group}</li>
              ))}
            </ul>
          </ProfileRow>
        )}
      </dl>
    </Section>
  )
}

/** Language picker — the selection persists to localStorage('voc-language') via the i18n detector cache. */
function LanguageField() {
  const { t, i18n } = useTranslation('common')
  const id = useId()
  const resolved = i18n.resolvedLanguage ?? ''
  const current = isSupportedLanguage(resolved) ? resolved : 'en'
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <label htmlFor={id} className="text-sm text-text">{t('account.language')}</label>
      <select
        id={id}
        value={current}
        onChange={(e) => {
          changeLanguage(e.target.value).catch((err: unknown) => {
            // Locale bundle fetch can fail (offline / HTTP backend error).
            console.error('Language change failed:', err)
          })
        }}
        className="select sm:max-w-xs"
      >
        {supportedLanguages.map((lang) => <option key={lang} value={lang}>{languageNames[lang]}</option>)}
      </select>
    </div>
  )
}

export function PreferencesSection() {
  const { t } = useTranslation('common')
  return (
    <Section icon={SlidersHorizontal} title={t('account.preferences')}>
      <LanguageField />
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-text">{t('account.theme')}</span>
        <ThemeToggle />
      </div>
    </Section>
  )
}

export function McpTokensSection() {
  const { t } = useTranslation('common')
  return (
    <Section icon={Plug} title={t('account.mcpTitle')}>
      <p className="text-sm text-muted">
        {t('account.mcpHint')} <Link to="/connect" className="link">{t('account.mcpLink')}</Link>
      </p>
    </Section>
  )
}

export function SignOutSection({ onSignOut }: Readonly<{ onSignOut: () => void }>) {
  const { t } = useTranslation('common')
  return (
    <Section icon={LogOut} title={t('account.signOut')} description={t('account.signOutHint')}>
      <div>
        <button type="button" className="btn btn-secondary" onClick={onSignOut}>
          <LogOut size={16} aria-hidden="true" /> {t('account.signOut')}
        </button>
      </div>
    </Section>
  )
}
