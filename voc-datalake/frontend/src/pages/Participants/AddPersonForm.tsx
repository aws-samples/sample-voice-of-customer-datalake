/**
 * @fileoverview "Add one person": email (required), name and company. Used on a list's
 * members and on a project's Participants tab. The parent decides what the submit does
 * (add to a list, link to a project); this form only collects and checks the fields.
 *
 * @module pages/Participants/AddPersonForm
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, UserPlus } from 'lucide-react'
import type { NewPersonInput } from '../../api/participantsApi'
import { isPlausibleEmail } from './participantInput'

export default function AddPersonForm({ onAdd, isPending, submitLabel }: Readonly<{
  onAdd: (person: NewPersonInput) => Promise<boolean>
  isPending: boolean
  submitLabel: string
}>) {
  const { t } = useTranslation('participants')
  const hintId = useId()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const invalid = email.trim() !== '' && !isPlausibleEmail(email)
  const ready = isPlausibleEmail(email) && !isPending

  const submit = async () => {
    const added = await onAdd({
      email: email.trim(),
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      ...(company.trim() === '' ? {} : { company: company.trim() }),
    })
    if (!added) return
    setEmail('')
    setName('')
    setCompany('')
  }

  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (ready) void submit() }}>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs text-muted mb-1">{t('person.email')}</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            aria-invalid={invalid} aria-describedby={invalid ? hintId : undefined} className="input w-full" />
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">{t('person.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="input w-full" />
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">{t('person.company')}</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} className="input w-full" />
        </label>
      </div>
      {invalid ? <p id={hintId} className="text-xs text-danger">{t('errors.invalidEmail')}</p> : null}
      <button type="submit" disabled={!ready} className="btn btn-secondary btn-sm">
        {isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <UserPlus size={14} aria-hidden />}
        {submitLabel}
      </button>
    </form>
  )
}
