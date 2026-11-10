/**
 * @fileoverview The public unsubscribe page an ask-for-feedback email links to
 * (`/unsubscribe?t=<token>`, docs/participants.md).
 *
 * A DELIBERATELY UNAUTHENTICATED ROUTE, like `/vote`: the emailed token is the only
 * control, and it grants exactly one thing — "stop emailing this person". Outside the app
 * shell, so it supplies its own `<main>`.
 *
 * NEVER posts on load: mail scanners and link previewers fetch every link in a message, and
 * an automatic POST would unsubscribe people who never clicked. The person presses the one
 * button. (Mail clients' own one-click unsubscribe uses the RFC 8058 header straight to the
 * API, not this page.) The API answers 200 whatever the token, so the page cannot and does
 * not say whether the token was known.
 *
 * @module pages/Unsubscribe
 */
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2, Loader2, MailX } from 'lucide-react'
import { unsubscribe } from '../../api/participantsApi'

function Done() {
  const { t } = useTranslation('participants')
  return (
    <section role="status" aria-labelledby="unsubscribe-done" className="space-y-1 rounded-lg border border-ok/30 bg-ok-subtle p-4">
      <h2 id="unsubscribe-done" className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <CheckCircle2 size={18} className="text-ok shrink-0" aria-hidden />
        {t('unsubscribe.doneTitle')}
      </h2>
      <p className="text-sm text-text">{t('unsubscribe.doneBody')}</p>
    </section>
  )
}

function Ask({ token }: Readonly<{ token: string }>) {
  const { t } = useTranslation('participants')
  const confirm = useMutation({ mutationFn: () => unsubscribe(token) })
  if (confirm.data === true) return <Done />
  return (
    <div className="card space-y-3">
      <p className="text-sm text-text">{t('unsubscribe.body')}</p>
      {confirm.data === false ? <p role="alert" className="text-sm text-danger">{t('unsubscribe.failed')}</p> : null}
      <button type="button" onClick={() => confirm.mutate()} disabled={confirm.isPending} className="btn btn-primary">
        {confirm.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <MailX size={14} aria-hidden />}
        {t('unsubscribe.button')}
      </button>
    </div>
  )
}

export default function Unsubscribe() {
  const { t } = useTranslation('participants')
  const [searchParams] = useSearchParams()
  const token = (searchParams.get('t') ?? '').trim()
  return (
    <main className="min-h-screen bg-bg px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-lg space-y-5">
        <h1 className="text-xl font-bold tracking-tight text-text-strong">{t('unsubscribe.title')}</h1>
        {token === '' ? <p className="card text-sm text-text">{t('unsubscribe.missingToken')}</p> : <Ask token={token} />}
      </div>
    </main>
  )
}
