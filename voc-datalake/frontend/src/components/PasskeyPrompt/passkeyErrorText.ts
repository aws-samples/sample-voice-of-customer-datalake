import { PasskeyError } from '../../services/passkey'
import type { PasskeyErrorCode } from '../../services/passkey'

type Translate = (key: string) => string

/** The `login:passkey.errors.*` text for a failed passkey step (`t` bound to the `login` namespace). */
export function passkeyErrorText(t: Translate, error: unknown): string {
  const code: PasskeyErrorCode = error instanceof PasskeyError ? error.code : 'unknown'
  switch (code) {
    case 'cancelled': return t('login:passkey.errors.cancelled')
    case 'no_passkey': return t('login:passkey.errors.no_passkey')
    case 'unsupported': return t('login:passkey.errors.unsupported')
    case 'unknown': return t('login:passkey.errors.unknown')
  }
}
