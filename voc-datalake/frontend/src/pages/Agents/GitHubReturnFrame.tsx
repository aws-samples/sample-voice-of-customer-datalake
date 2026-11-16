/**
 * @fileoverview The frame both pages GitHub sends an administrator back to share (GitHubAppCreated.tsx,
 * GitHubAppInstalled.tsx; 7.45.00): their title, what they say, and the way back to Agents → Connections.
 *
 * @module pages/Agents/GitHubReturnFrame
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { agentsPath } from './agentsPaths'
import type { ReactNode } from 'react'

/** The frame both GitHub return pages share: their title, what they say, and the way back to the connections. */
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
