/**
 * @fileoverview Settings → Users → "Category access": which categories of
 * reviews one user may see, and from which sources (`SourceAccessFields`).
 *
 * "All categories" (the default — no stored row means all, so nobody loses
 * access when the feature ships) or a selected list. Two facts the dialog states
 * because the backend applies them regardless of what is saved here: admins
 * always see everything, and a category's product owners always see it.
 *
 * @module components/UserAdmin/CategoryAccessModal
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, ShieldCheck } from 'lucide-react'
import { callerCategoryScopeKey, categoryAccessApi, userCategoryAccessKey } from '../../api/categoryAccessApi'
import { useCategoriesConfig } from '../../hooks/useCategories'
import ModalShell from '../ModalShell/ModalShell'
import SourceAccessFields from './SourceAccessFields'
import DialogClose from '../DialogClose/DialogClose'
import type { CategoryScope, SourceGrant, UserCategoryGrant } from '../../api/categoryAccessApi'
import type { CognitoUser } from '../../api/types'

interface CategoryAccessModalProps {
  readonly user: CognitoUser | null
  readonly onClose: () => void
  readonly onSaved: (email: string) => void
}

function CategoryChecklist({ selected, onToggle, disabled }: Readonly<{
  selected: ReadonlySet<string>
  onToggle: (name: string) => void
  disabled: boolean
}>) {
  const { t } = useTranslation('components')
  const { data, isLoading } = useCategoriesConfig()
  const categories = data?.categories ?? []
  if (isLoading) return <Loader2 size={16} className="animate-spin text-muted" aria-hidden="true" />
  if (categories.length === 0) return <p className="text-sm text-muted">{t('userAdmin.categoryAccess.noCategories')}</p>
  return (
    <ul className="max-h-64 overflow-y-auto space-y-1 rounded-md border border-border p-2">
      {categories.map((c) => (
        <li key={c.id}>
          <label className="flex items-start gap-2 rounded-sm px-2 py-1 hover:bg-bg-hover cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(c.name)}
              onChange={() => onToggle(c.name)}
              disabled={disabled}
              className="mt-0.5 rounded-sm accent-accent"
            />
            <span className="min-w-0">
              <span className="block text-sm text-text-strong">{c.description ?? c.name}</span>
              <span className="block text-xs text-muted font-mono">
                {c.product === undefined ? c.name : `${c.name} · ${c.product}`}
              </span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}

function AccessForm({ user, grant, onClose, onSaved }: Readonly<{
  user: CognitoUser
  grant: UserCategoryGrant
  onClose: () => void
  onSaved: (email: string) => void
}>) {
  const { t } = useTranslation('components')
  const queryClient = useQueryClient()
  const [all, setAll] = useState(grant.all)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(grant.categories))
  const [sourceGrant, setSourceGrant] = useState<SourceGrant>(grant.sourceGrant)
  const save = useMutation({
    mutationFn: (scope: CategoryScope) => categoryAccessApi.saveUserGrant(user.username, scope, sourceGrant),
    onSuccess: (saved) => {
      queryClient.setQueryData(userCategoryAccessKey(user.username), saved)
      // Only matters when an admin edits their own row, but it is cheap and
      // keeps that admin's filters in step with what was just stored.
      void queryClient.invalidateQueries({ queryKey: callerCategoryScopeKey() })
      onSaved(user.email)
      onClose()
    },
  })
  const toggle = (name: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })
  const isAdmin = user.groups.includes('admins')

  return (
    <>
      <div className="dialog-body space-y-3">
        {isAdmin && <p className="text-sm text-text bg-info-subtle border border-info/30 rounded-md px-3 py-2">{t('userAdmin.categoryAccess.adminNote')}</p>}
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('userAdmin.categoryAccess.title')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="category-access" checked={all} onChange={() => setAll(true)} className="accent-accent" />
            <span className="text-text-strong">{t('userAdmin.categoryAccess.all')}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="category-access" checked={!all} onChange={() => setAll(false)} className="accent-accent" />
            <span className="text-text-strong">{t('userAdmin.categoryAccess.selected')}</span>
          </label>
        </fieldset>
        {!all && <CategoryChecklist selected={selected} onToggle={toggle} disabled={save.isPending} />}
        <p className="text-xs text-muted">{t('userAdmin.categoryAccess.ownersNote')}</p>
        <SourceAccessFields value={sourceGrant} onChange={setSourceGrant} disabled={save.isPending} />
        {save.isError && (
          <p role="alert" className="text-sm text-danger flex items-center gap-2">
            <AlertCircle size={14} aria-hidden="true" /> {t('userAdmin.categoryAccess.saveError')}
          </p>
        )}
      </div>
      <div className="dialog-footer flex-col-reverse sm:flex-row sm:gap-3">
        <button type="button" onClick={onClose} className="btn btn-secondary w-full sm:w-auto">{t('userAdmin.cancel')}</button>
        <button
          type="button"
          onClick={() => save.mutate({ all, categories: [...selected] })}
          disabled={save.isPending || (!all && selected.size === 0) || (sourceGrant.mode === 'list' && sourceGrant.sources.length === 0)}
          className="btn btn-primary w-full sm:w-auto"
        >
          {save.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
          {t('userAdmin.saveChanges')}
        </button>
      </div>
    </>
  )
}

function AccessBody({ user, onClose, onSaved }: Readonly<{ user: CognitoUser; onClose: () => void; onSaved: (email: string) => void }>) {
  const { t } = useTranslation('components')
  const { data: grant, isLoading, isError } = useQuery({
    queryKey: userCategoryAccessKey(user.username),
    queryFn: () => categoryAccessApi.getUserGrant(user.username),
  })
  if (isLoading) {
    return <div className="dialog-body flex justify-center py-6"><Loader2 className="animate-spin text-accent" size={24} aria-hidden="true" /></div>
  }
  if (isError || grant === undefined) {
    return <div className="dialog-body"><p role="alert" className="text-sm text-danger">{t('userAdmin.categoryAccess.loadError')}</p></div>
  }
  return <AccessForm key={user.username} user={user} grant={grant} onClose={onClose} onSaved={onSaved} />
}

export default function CategoryAccessModal({ user, onClose, onSaved }: CategoryAccessModalProps) {
  const { t } = useTranslation('components')
  const titleId = useId()
  if (user === null) return null
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-md w-full max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <ShieldCheck size={20} className="text-accent shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title">{t('userAdmin.categoryAccess.title')}</h2>
            <p className="dialog-description truncate">{user.email}</p>
          </div>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <AccessBody user={user} onClose={onClose} onSaved={onSaved} />
    </ModalShell>
  )
}
