/**
 * @fileoverview The GitHub Issues card's "Sign in with" select (7.45.00, the deployment's card only:
 * githubSignIn.ts): a fine-grained token, or one of the deployment's GitHub Apps.
 *
 * @module pages/Settings/GitHubSignInChoice
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { SignInMethod } from './githubSignIn'

export function GitHubSignInChoice({ method, onChoose }: Readonly<{ method: SignInMethod; onChoose: (method: SignInMethod) => void }>) {
  const { t } = useTranslation('settings')
  const id = useId()
  const hintId = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-xs sm:text-sm font-medium text-text mb-1">{t('sourceCard.githubSignIn.label')}</label>
      <select id={id} className="select text-xs sm:text-sm" value={method} aria-describedby={hintId}
        onChange={(event) => { onChoose(event.target.value === 'app' ? 'app' : 'token') }}>
        <option value="token">{t('sourceCard.githubSignIn.token')}</option>
        <option value="app">{t('sourceCard.githubSignIn.app')}</option>
      </select>
      <p id={hintId} className="text-xs text-muted mt-1">
        {method === 'app' ? t('sourceCard.githubSignIn.appHint') : t('sourceCard.githubSignIn.tokenHint')}
      </p>
    </div>
  )
}
