/**
 * @fileoverview Add a member by email, with a role (workspace admins only; `POST /me/workspaces/current/members`).
 *
 * An email with an account becomes a member at once; the server sends it no email, so the answer says to tell
 * them. A new email first gets an account with a temporary password emailed, which only a deployment administrator
 * may ask for (403 otherwise: the refusal says so). The form checks the address's shape before sending; the server
 * checks it again.
 *
 * @module pages/Members/AddMemberForm
 */
import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { UserPlus } from 'lucide-react'
import { looksLikeEmail } from '../../utils/looksLikeEmail'
import { WORKSPACE_ROLES } from '../../api/workspacesApi'
import type { WorkspaceRole } from '../../api/workspacesApi'

/** The longest address the server takes (RFC 5321). */
const EMAIL_MAX = 254

interface AddMemberFormProps {
  readonly busy: boolean
  /** Send the add; rejects with the server's refusal, which the page shows (the address then stays to correct). */
  readonly onAdd: (email: string, role: WorkspaceRole) => Promise<unknown>
}

export default function AddMemberForm({ busy, onAdd }: AddMemberFormProps) {
  const { t } = useTranslation()
  const ids = { email: useId(), role: useId(), hint: useId() }
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('viewer')
  const [invalid, setInvalid] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    const address = email.trim()
    if (!looksLikeEmail(address)) {
      // The error is rendered (and named as the field's description) before focus moves there, so it is read out.
      flushSync(() => setInvalid(true))
      emailRef.current?.focus()
      return
    }
    setInvalid(false)
    onAdd(address, role).then(() => setEmail(''), () => {
      // The page shows the refusal.
    })
  }

  return (
    <form className="card space-y-3" noValidate aria-labelledby={`${ids.email}-title`}
      onSubmit={(event) => { event.preventDefault(); submit() }}>
      <h2 id={`${ids.email}-title`} className="text-base font-semibold tracking-tight text-text-strong">{t('workspaces.members.addTitle')}</h2>
      <p id={ids.hint} className="text-sm text-muted">{t('workspaces.members.addHint')}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-text">
          <label htmlFor={ids.email}>{t('workspaces.members.email')}</label>
          <input
            ref={emailRef}
            id={ids.email}
            type="email"
            className="input"
            autoComplete="off"
            maxLength={EMAIL_MAX}
            value={email}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${ids.email}-error ${ids.hint}` : ids.hint}
            onChange={(event) => {
              setEmail(event.target.value)
              setInvalid(false)
            }}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm text-text">
          <label htmlFor={ids.role}>{t('workspaces.members.role')}</label>
          <select id={ids.role} className="select" value={role}
            onChange={(event) => setRole(WORKSPACE_ROLES.find((option) => option === event.target.value) ?? 'viewer')}>
            {WORKSPACE_ROLES.map((option) => <option key={option} value={option}>{t(`workspaces.role.${option}`)}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn-primary gap-2 justify-center" disabled={busy}>
          <UserPlus size={16} aria-hidden="true" />
          {t('workspaces.members.add')}
        </button>
      </div>
      {invalid ? <p id={`${ids.email}-error`} className="text-sm text-danger">{t('workspaces.members.emailInvalid')}</p> : null}
    </form>
  )
}
