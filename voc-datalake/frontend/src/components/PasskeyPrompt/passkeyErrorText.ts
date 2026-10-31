import type { TFunction } from 'i18next'
import { PasskeyError } from '../../services/passkey'
import type { PasskeyErrorCode } from '../../services/passkey'

/** The `login:passkey.errors.*` text for a failed passkey step (`t` bound to the `login` namespace). */
export function passkeyErrorText(t: TFunction<'login'>, error: unknown): string {
  const code: PasskeyErrorCode = error instanceof PasskeyError ? error.code : 'unknown'
  switch (code) {
    case 'cancelled': return t('passkey.errors.cancelled')
    case 'no_passkey': return t('passkey.errors.no_passkey')
    case 'unsupported': return t('passkey.errors.unsupported')
    case 'unknown': return t('passkey.errors.unknown')
  }
}
