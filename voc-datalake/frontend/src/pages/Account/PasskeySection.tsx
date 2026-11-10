/**
 * @fileoverview Account -> Profile -> Passkey: the person's passkeys (Cognito WebAuthn), adding one for
 * this device (the same action as the one-time offer after sign-in) and removing one, e.g. a lost or
 * replaced device's. Hidden when the deployment or the browser has none.
 * @module pages/Account/PasskeySection
 */
import { CheckCircle2, KeyRound, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Section } from './ProfileSections'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import AddPasskeyButton from '../../components/PasskeyPrompt/AddPasskeyButton'
import { passkeyErrorText } from '../../components/PasskeyPrompt/passkeyErrorText'
import { usePasskeyList, useRegisterPasskey, useRemovePasskey } from '../../components/PasskeyPrompt/usePasskey'
import { canUsePasskeys } from '../../services/passkeyAuth'
import type { PasskeyInfo } from '../../services/passkeyAuth'
import { formatDate } from '../../utils/dateUtils'

function PasskeyRow({ passkey, onRemove }: Readonly<{ passkey: PasskeyInfo; onRemove: (passkey: PasskeyInfo) => void }>) {
  const { t, i18n } = useTranslation('login')
  const name = passkey.name ?? t('passkey.section.unnamed')
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-text-strong break-words">{name}</p>
        {passkey.createdAt ? (
          <p className="text-xs text-muted">{t('passkey.section.addedOn', { date: formatDate(passkey.createdAt, i18n.language) })}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('passkey.section.remove', { name })}
        title={t('passkey.section.remove', { name })}
        onClick={() => onRemove(passkey)}
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </li>
  )
}

export default function PasskeySection() {
  const { t } = useTranslation('login')
  const register = useRegisterPasskey()
  const remove = useRemovePasskey()
  const list = usePasskeyList()
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null)
  if (!canUsePasskeys()) return null
  const passkeys = list.data ?? []
  // Only an action the person took shows an alert; a list that cannot be read leaves the add-only view.
  const failure = register.error ?? remove.error
  return (
    <Section icon={KeyRound} title={t('passkey.section.title')} description={t('passkey.section.intro')}>
      {passkeys.length > 0 ? (
        <ul className="divide-y divide-border">
          {passkeys.map((passkey) => <PasskeyRow key={passkey.id} passkey={passkey} onRemove={setRemoving} />)}
        </ul>
      ) : null}
      {list.isSuccess && passkeys.length === 0 ? <p className="text-sm text-muted">{t('passkey.section.none')}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <AddPasskeyButton pending={register.isPending} onAdd={() => register.mutate()} />
        {register.isSuccess ? (
          <p role="status" className="flex items-center gap-2 text-sm text-ok">
            <CheckCircle2 size={16} aria-hidden="true" /> {t('passkey.section.added')}
          </p>
        ) : null}
      </div>
      {failure ? <p role="alert" className="text-sm text-danger">{passkeyErrorText(t, failure)}</p> : null}
      <ConfirmModal
        isOpen={removing !== null}
        title={t('passkey.section.removeTitle')}
        message={t('passkey.section.removeBody')}
        confirmLabel={t('passkey.section.removeConfirm')}
        variant="danger"
        isLoading={remove.isPending}
        onConfirm={() => {
          if (!removing) return
          register.reset()
          remove.mutate(removing.id, { onSettled: () => setRemoving(null) })
        }}
        onCancel={() => setRemoving(null)}
      />
    </Section>
  )
}
