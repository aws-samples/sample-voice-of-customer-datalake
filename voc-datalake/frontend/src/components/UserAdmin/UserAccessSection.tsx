/**
 * @fileoverview People → a person's editor → category and source access: the stored rule in plain words
 * (`AccessSummary`, `GET /users/{username}/category-access`) and "Change access…", which opens the Category access
 * dialog over the sheet (CategoryAccessModal.tsx: its own form and Save). A save there reads as the sheet's "Saved".
 * @module components/UserAdmin/UserAccessSection
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, ShieldCheck } from 'lucide-react'
import { categoryAccessApi, userCategoryAccessKey } from '../../api/categoryAccessApi'
import type { CognitoUser } from '../../api/types'
import AccessSummary from './AccessSummary'
import CategoryAccessModal from './CategoryAccessModal'
import SheetSection from './SheetSection'
import { useSheetReport } from './useSheetSave'

function StoredAccess({ username }: Readonly<{ username: string }>) {
  const { t } = useTranslation('components')
  const grant = useQuery({ queryKey: userCategoryAccessKey(username), queryFn: () => categoryAccessApi.getUserGrant(username) })
  if (grant.isPending) return <Loader2 size={16} className="animate-spin text-muted" aria-hidden="true" />
  if (grant.isError) return <p className="text-sm text-danger">{t('userAdmin.categoryAccess.loadError')}</p>
  return <AccessSummary grant={grant.data} />
}

export default function UserAccessSection({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  const report = useSheetReport()
  const [open, setOpen] = useState(false)
  return (
    <SheetSection title={t('userAdmin.editor.sections.access')}>
      <StoredAccess username={user.username} />
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { report?.edited(); setOpen(true) }}>
        <ShieldCheck size={14} aria-hidden="true" /> {t('userAdmin.editor.changeAccess')}
      </button>
      <CategoryAccessModal user={open ? user : null} onClose={() => setOpen(false)} onSaved={() => report?.saved()} />
    </SheetSection>
  )
}
