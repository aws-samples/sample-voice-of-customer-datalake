/**
 * @fileoverview People → one person's editor (`/admin/access/users/<username>`, 7.54.00): a SideSheet that holds everything
 * set per person, where four lists used to repeat everyone (the users table, flags, platform admins and ways of
 * working):
 *
 * - role · way of working with AI · category and source access · memory and ownership flags · platform admin
 *   (platform admins only) · name · account (password reset, disable or enable), and **Delete {{name}}…** at the foot.
 *
 * Each section saves itself (useSheetSave.ts); the sheet says "Saved" once, in one `role="status"` beside the foot
 * (components/SavedStatus), after any section's save the server accepted and until the next edit in the sheet. The
 * sheet edits the row of the users list it was opened from, so a save's refetch shows the stored values at once.
 *
 * @module components/UserAdmin/UserEditorSheet
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserCog } from 'lucide-react'
import type { CognitoUser } from '../../api/types'
import SavedStatus from '../SavedStatus/SavedStatus'
import SideSheet from '../SideSheet/SideSheet'
import { AccountSection, DeleteAction } from './UserAccountActions'
import { useAccountAction } from './useAccountAction'
import UserAccessSection from './UserAccessSection'
import UserNameSection from './UserNameSection'
import { FlagsSection, PlatformAdminSection, RoleSection } from './UserRoleFlags'
import WaysOfWorking from './WaysOfWorking'
import { displayName } from './userFacts'
import { SheetSaveContext } from './useSheetSave'
import type { SheetSaveReport } from './useSheetSave'

interface UserEditorSheetProps {
  readonly user: CognitoUser
  readonly onClose: () => void
  /** The person was deleted: `said` is what the People page tells (the sheet is gone). */
  readonly onDeleted: (said: string) => void
}

/** The sheet's one "Saved": a save landed (in its words or the default), until the next edit. */
function useSavedLine(): [{ readonly saved: boolean; readonly label?: string }, SheetSaveReport] {
  const [line, setLine] = useState<{ readonly saved: boolean; readonly label?: string }>({ saved: false })
  const report = useMemo<SheetSaveReport>(() => ({
    edited: () => setLine({ saved: false }),
    saved: (label?: string) => setLine({ saved: true, label }),
  }), [])
  return [line, report]
}

export default function UserEditorSheet({ user, onClose, onDeleted }: UserEditorSheetProps) {
  const { t } = useTranslation('components')
  const [line, report] = useSavedLine()
  const account = useAccountAction(user, onDeleted, report)
  return (
    <SheetSaveContext.Provider value={report}>
      <SideSheet isOpen onClose={onClose} icon={UserCog} title={t('userAdmin.editor.title', { name: displayName(user) })}
        description={user.email}
        footer={<><SavedStatus saved={line.saved} label={line.label} /><DeleteAction user={user} state={account} /></>}>
        <RoleSection user={user} />
        <WaysOfWorking user={user} />
        <UserAccessSection user={user} />
        <FlagsSection user={user} />
        <PlatformAdminSection user={user} />
        <UserNameSection user={user} />
        <AccountSection user={user} state={account} />
      </SideSheet>
    </SheetSaveContext.Provider>
  )
}
