import { KeyRound, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** "Add a passkey", with a spinner while the browser and Cognito register it. */
export default function AddPasskeyButton({ pending, onAdd }: Readonly<{ pending: boolean; onAdd: () => void }>) {
  const { t } = useTranslation('login')
  return (
    <button type="button" className="btn btn-primary" disabled={pending} onClick={onAdd}>
      {pending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
      {t('passkey.add')}
    </button>
  )
}
