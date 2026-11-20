/**
 * @fileoverview The frame the pages GitHub sends a person back to share (GitHubAppCreated.tsx, GitHubAppInstalled.tsx;
 * 7.45.00): their title, what they say, and the way back to Agents → Connections;
 * and what each says before its request's answer (`ReturnProgress`).
 *
 * @module pages/Agents/GitHubReturnFrame
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { agentsPath } from './agentsPaths'
import { useConnectionError } from './connectionText'
import type { ReactNode } from 'react'
import type { RequestOutcome } from './githubCallback'

/** The frame the GitHub return pages share: their title, what they say, and the way back to the connections. */
export function GitHubReturnFrame({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0 max-w-prose">
      <h1 className="text-2xl font-bold tracking-tight text-text-strong">{title}</h1>
      <div className="card p-4 space-y-3">{children}</div>
      <Link to={agentsPath({ view: 'connections' })} className="btn btn-secondary btn-sm">{t('connections.githubReturn.back')}</Link>
    </div>
  )
}

/**
 * A return page's request before its answer: why nothing was sent (`idle`), that it is under way (`pending`), or its
 * refusal in the connections' words (`failed`). The page says what came of an answer itself.
 */
export function ReturnProgress({ outcome, idle, pending }: Readonly<{
  outcome: Exclude<RequestOutcome<unknown>, { kind: 'done' }>
  idle: string
  pending: string
}>) {
  const errorText = useConnectionError()
  switch (outcome.kind) {
    case 'idle':
      return <p className="text-sm text-text">{idle}</p>
    case 'pending':
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {pending}
        </p>
      )
    case 'failed':
      return <p role="alert" className="text-sm text-danger">{errorText(outcome.error)}</p>
  }
}
