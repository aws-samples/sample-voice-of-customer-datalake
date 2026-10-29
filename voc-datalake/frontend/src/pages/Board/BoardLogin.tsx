/**
 * @fileoverview `/board/login`: email → "check your email" with a code input. The emailed link
 * (`?email=&code=`) finishes by itself in the browser that asked for it; elsewhere the page says
 * to type the code in that browser or send a new link from this one.
 *
 * @module pages/Board/BoardLogin
 */
import { Loader2, Mail } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { isReviewPath, normalizeBoardEmail } from '../../services/boardAuth'
import { BoardAuthError } from '../../services/boardCognito'
import { useBoardSessionStore } from '../../store/boardSessionStore'
import { BOARD_PARAM, boardLandingPath } from './boardHost'
import { hasSignInParams, withoutSignInParams } from './signInLink'
import type { BoardAuth } from '../../services/boardAuth'
import type { BoardAuthErrorCode } from '../../services/boardCognito'
import { AUTH_ERROR_LABELS } from '../FeatureRequests/boardLabels'

/** Cognito's email one-time codes are 6 or 8 digits (the pool's setting). */
const OTP_MAX_DIGITS = 8

const codeOf = (error: unknown): BoardAuthErrorCode => (error instanceof BoardAuthError ? error.code : 'unknown')

/** The emailed link's `email` + `code`, read once when the page opens (the address is cleaned right after). */
interface SignInLink {
  readonly email: string | null
  readonly code: string | null
}

function readLink(params: URLSearchParams): SignInLink {
  return { email: params.get('email'), code: params.get('code') }
}

interface LoginState {
  readonly email: string
  readonly step: 'email' | 'code'
  readonly busy: boolean
  readonly error: BoardAuthErrorCode | null
  /** The emailed link was opened in a browser with no pending sign-in. */
  readonly foreignLink: boolean
  /** The first code confirmed the account and a second one was emailed to sign in. */
  readonly secondCode: boolean
}

/** What the emailed link (if any) means in this browser. */
type LinkKind = 'none' | 'live' | 'late' | 'foreign'

function linkKind(auth: BoardAuth, linkEmail: string | null, linked: boolean): LinkKind {
  if (!linked || linkEmail === null) return 'none'
  // Before pending(), which forgets an expired entry: a late link in THIS browser is "expired".
  if (auth.pendingExpiredFor(linkEmail)) return 'late'
  return auth.pending()?.email === normalizeBoardEmail(linkEmail) ? 'live' : 'foreign'
}

function initialState(auth: BoardAuth, link: SignInLink): LoginState {
  const linkEmail = link.email
  const kind = linkKind(auth, linkEmail, linkEmail !== null && link.code !== null)
  const pending = auth.pending()
  const usable = kind === 'none' || kind === 'live'
  return {
    email: pending?.email ?? linkEmail ?? '',
    step: pending && usable ? 'code' : 'email',
    busy: kind === 'live',
    error: kind === 'late' ? 'expired' : null,
    foreignLink: kind === 'foreign',
    secondCode: false,
  }
}

function useBoardLogin(auth: BoardAuth, returnTo: string | undefined) {
  const [params, setParams] = useSearchParams()
  const setSignedIn = useBoardSessionStore((state) => state.setSignedIn)
  const [link] = useState<SignInLink>(() => readLink(params))
  const [state, setState] = useState<LoginState>(() => initialState(auth, link))
  useEffect(() => {
    // The one-time code must not stay in the address bar or history: replace this entry once read.
    const search = params.toString()
    if (hasSignInParams(search)) setParams(new URLSearchParams(withoutSignInParams(search)), { replace: true })
  }, [params, setParams])
  const patch = (next: Partial<LoginState>) => setState((prev) => ({ ...prev, ...next }))
  const verify = async (code: string, email?: string) => {
    patch({ busy: true, error: null })
    // Read before verifyCode, which forgets the pending sign-in (and the target kept with it).
    const remembered = auth.pending()
    try {
      const result = await auth.verifyCode(code, email)
      if (result.status === 'next') {
        patch({ busy: false, step: 'code', secondCode: true })
        return
      }
      // The signed-in `/board/login` route redirects to `landing` (one owner, no navigate race).
      const review = returnTo ?? remembered?.returnTo
      setSignedIn(result.email, isReviewPath(review) ? review : boardLandingPath(params, remembered?.board))
    } catch (error) {
      const reason = codeOf(error)
      patch({ busy: false, error: reason, step: reason === 'wrong_code' ? 'code' : 'email' })
    }
  }
  const send = async (email: string) => {
    patch({ busy: true, error: null, email, secondCode: false })
    try {
      await auth.requestCode(email, { board: params.get(BOARD_PARAM) ?? undefined, returnTo })
      patch({ busy: false, step: 'code', foreignLink: false })
    } catch (error) {
      patch({ busy: false, error: codeOf(error) })
    }
  }
  const restart = () => {
    auth.cancelPending()
    patch({ step: 'email', error: null, foreignLink: false, secondCode: false })
  }
  return { state, link, verify, send, restart }
}

function EmailStep({ email, busy, onSend }: Readonly<{ email: string; busy: boolean; onSend: (email: string) => void }>) {
  const { t } = useTranslation('featureRequests')
  const [value, setValue] = useState(email)
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (value.trim() !== '') onSend(value) }}>
      <LabeledField label={t('auth.email')}>
        {(id) => <input id={id} type="email" autoComplete="email" className="input w-full" value={value} onChange={(e) => setValue(e.target.value)} />}
      </LabeledField>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || value.trim() === ''}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Mail size={14} aria-hidden="true" />}
        {t('auth.sendLink')}
      </button>
    </form>
  )
}

function CodeStep({ email, busy, secondCode, onVerify, onRestart }: Readonly<{
  email: string; busy: boolean; secondCode: boolean; onVerify: (code: string) => void; onRestart: () => void
}>) {
  const { t } = useTranslation('featureRequests')
  const [code, setCode] = useState('')
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (code.trim() !== '') { onVerify(code); setCode('') } }}>
      <p role="status" className="text-sm text-text break-words">
        {secondCode ? t('auth.secondCode', { email }) : t('auth.checkEmail', { email })}
      </p>
      <LabeledField label={t('auth.code')}>
        {(id) => (
          <input id={id} inputMode="numeric" autoComplete="one-time-code" className="input w-full tracking-widest"
            value={code} onChange={(e) => setCode(e.target.value.replaceAll(/\D/g, '').slice(0, OTP_MAX_DIGITS))} />
        )}
      </LabeledField>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || code === ''}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {t('auth.signIn')}
      </button>
      <button type="button" className="btn btn-ghost btn-sm w-full" onClick={onRestart}>{t('auth.useAnotherEmail')}</button>
    </form>
  )
}

interface BoardLoginProps {
  readonly auth: BoardAuth
  /** A review page to return to (`/review/shr_…`): the review page renders this form inline. */
  readonly returnTo?: string
  readonly title?: string
  readonly intro?: string
}

export default function BoardLogin({ auth, returnTo, title, intro }: Readonly<BoardLoginProps>) {
  const { t } = useTranslation('featureRequests')
  const { state, link, verify, send, restart } = useBoardLogin(auth, returnTo)
  const started = useRef(false)
  useEffect(() => {
    // The emailed link, opened where the sign-in started and still live (initial `busy`): finish it once, by itself.
    const { email, code } = link
    if (started.current || email === null || code === null || !state.busy) return
    started.current = true
    void verify(code, email)
  })
  return (
    <div className="card p-6 space-y-4 w-full max-w-sm">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-text-strong">{title ?? t('auth.title')}</h1>
        <p className="text-sm text-muted">{intro ?? t('auth.intro')}</p>
      </div>
      {state.foreignLink ? <p role="alert" className="text-sm text-warn">{t('auth.otherBrowser')}</p> : null}
      {state.error === null ? null : <p role="alert" className="text-sm text-danger">{t(AUTH_ERROR_LABELS[state.error].messageKey)}</p>}
      {state.step === 'email' ? (
        <EmailStep email={state.email} busy={state.busy} onSend={(email) => { void send(email) }} />
      ) : (
        <CodeStep email={state.email} busy={state.busy} secondCode={state.secondCode}
          onVerify={(code) => { void verify(code) }} onRestart={restart} />
      )}
    </div>
  )
}
