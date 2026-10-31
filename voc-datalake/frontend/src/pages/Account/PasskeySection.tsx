/**
 * @fileoverview Account -> Profile -> Passkey: add a passkey for this device (Cognito WebAuthn), the
 * same action as the one-time offer after sign-in. Hidden when the deployment or the browser has none.
 * @module pages/Account/PasskeySection
 */
import { CheckCircle2, KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Section } from './ProfileSections'
import AddPasskeyButton from '../../components/PasskeyPrompt/AddPasskeyButton'
import { passkeyErrorText } from '../../components/PasskeyPrompt/passkeyErrorText'
import { useRegisterPasskey } from '../../components/PasskeyPrompt/usePasskey'
import { canUsePasskeys } from '../../services/passkeyAuth'

export default function PasskeySection() {
  const { t } = useTranslation('login')
  const register = useRegisterPasskey()
  if (!canUsePasskeys()) return null
  return (
    <Section icon={KeyRound} title={t('passkey.section.title')} description={t('passkey.section.intro')}>
      <div className="flex flex-wrap items-center gap-3">
        <AddPasskeyButton pending={register.isPending} onAdd={() => register.mutate()} />
        {register.isSuccess ? (
          <p role="status" className="flex items-center gap-2 text-sm text-ok">
            <CheckCircle2 size={16} aria-hidden="true" /> {t('passkey.section.added')}
          </p>
        ) : null}
      </div>
      {register.isError ? <p role="alert" className="text-sm text-danger">{passkeyErrorText(t, register.error)}</p> : null}
    </Section>
  )
}
