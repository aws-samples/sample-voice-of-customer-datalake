/**
 * @fileoverview Account → Change password (Cognito `changePassword`, no REST
 * call). Inline on the page; was the second tab of the former profile modal.
 * @module pages/Account/PasswordSection
 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, Loader2, Lock } from 'lucide-react'
import { authService } from '../../services/auth'
import { Section } from './ProfileSections'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

const MIN_PASSWORD_LENGTH = 8
const SUCCESS_VISIBLE_MS = 3000

type Translate = (key: string) => string

function validatePasswordChange(current: string, next: string, confirm: string, t: Translate): string | null {
  if (current === '' || next === '' || confirm === '') return t('account.password.allRequired')
  if (next !== confirm) return t('account.password.mismatch')
  if (next.length < MIN_PASSWORD_LENGTH) return t('account.password.tooShort')
  return null
}

function getPasswordError(err: unknown, t: Translate): string {
  if (!(err instanceof Error) || err.message === '') return t('account.password.failed')
  return err.message.includes('Incorrect') ? t('account.password.incorrect') : err.message
}

function PasswordInput({ id, label, value, onChange, visible, placeholder, autoComplete }: Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  visible: boolean
  placeholder: string
  autoComplete: 'current-password' | 'new-password'
}>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{label}</label>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
    </div>
  )
}

export default function PasswordSection() {
  const { t } = useTranslation('common')
  const baseId = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [visible, setVisible] = useState(false)
  const [isChanging, setIsChanging] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!success) return undefined
    const timer = setTimeout(() => setSuccess(false), SUCCESS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [success])

  const submit = async () => {
    setError('')
    setSuccess(false)
    const validationError = validatePasswordChange(current, next, confirm, t)
    if (validationError !== null) {
      setError(validationError)
      return
    }
    setIsChanging(true)
    try {
      await authService.changePassword(current, next)
      setSuccess(true)
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      setError(getPasswordError(err, t))
    } finally {
      setIsChanging(false)
    }
  }

  const incomplete = current === '' || next === '' || confirm === ''
  return (
    <Section icon={Lock} title={t('account.password.title')} description={t('account.password.intro')}>
      <form
        className="space-y-4 max-w-md"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <PasswordInput id={`${baseId}-current`} label={t('account.password.current')} value={current} onChange={setCurrent} visible={visible} placeholder={t('account.password.currentPlaceholder')} autoComplete="current-password" />
        <PasswordInput id={`${baseId}-new`} label={t('account.password.new')} value={next} onChange={setNext} visible={visible} placeholder={t('account.password.newPlaceholder')} autoComplete="new-password" />
        <PasswordInput id={`${baseId}-confirm`} label={t('account.password.confirm')} value={confirm} onChange={setConfirm} visible={visible} placeholder={t('account.password.confirmPlaceholder')} autoComplete="new-password" />
        <label htmlFor={`${baseId}-show`} className="flex items-center gap-2 text-sm text-text cursor-pointer">
          <input id={`${baseId}-show`} type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="rounded-sm accent-accent" />
          {t('account.password.show')}
        </label>
        {error === '' ? null : (
          <div role="alert" className="flex items-start gap-2 text-sm text-danger bg-danger-subtle p-3 rounded-lg">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {success ? (
          <div role="status" className="flex items-center gap-2 text-sm text-ok bg-ok-subtle p-3 rounded-lg">
            <CheckCircle2 size={16} className="flex-shrink-0" aria-hidden="true" />
            {t('account.password.changed')}
          </div>
        ) : null}
        <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
          <button type="submit" disabled={isChanging || incomplete} className="btn btn-primary">
            {isChanging ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
            {isChanging ? t('account.password.changing') : t('account.password.submit')}
          </button>
          <p className="text-xs text-muted">{t('account.password.requirements')}</p>
        </StickyActionBar>
      </form>
    </Section>
  )
}
