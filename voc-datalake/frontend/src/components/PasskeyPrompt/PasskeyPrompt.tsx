/**
 * @fileoverview The one-time offer, after sign-in, to add a passkey (WA SEC02; docs/deployment.md ->
 * Passkeys). Shown above the page until the person adds one or says "Not now"; Account -> Profile
 * keeps the same action for later.
 * @module components/PasskeyPrompt
 */
import { KeyRound } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import AddPasskeyButton from './AddPasskeyButton'
import { passkeyErrorText } from './passkeyErrorText'
import { usePasskeyOffer, useRegisterPasskey } from './usePasskey'

export default function PasskeyPrompt() {
  const { t } = useTranslation('login')
  const titleId = useId()
  const offer = usePasskeyOffer()
  const register = useRegisterPasskey()
  if (!offer.show) return null
  return (
    <section aria-labelledby={titleId} className="card mb-4 flex flex-wrap items-start gap-3">
      <KeyRound size={20} className="text-accent-text flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-60">
        <h2 id={titleId} className="text-sm font-semibold text-text-strong">{t('passkey.offer.title')}</h2>
        <p className="text-sm text-muted break-words">{t('passkey.offer.body')}</p>
        {register.isError ? <p role="alert" className="text-sm text-danger mt-1">{passkeyErrorText(t, register.error)}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <AddPasskeyButton pending={register.isPending} onAdd={() => register.mutate(undefined, { onSuccess: offer.close })} />
        <button type="button" className="btn btn-secondary" disabled={register.isPending} onClick={offer.decline}>
          {t('passkey.offer.notNow')}
        </button>
      </div>
    </section>
  )
}
