/**
 * @fileoverview "Conversations from before workspaces": inside a workspace the history starts empty (its
 * conversations are `WS#{ws}#USER#{sub}`, docs/multi-workspace.md), so the person's earlier conversations, kept
 * deployment-wide under `USER#{sub}`, are offered here, read only, through the `'deployment'` request scope.
 *
 * Collapsed until asked for (nothing is fetched before), each one opens as a plain transcript: they are never opened
 * as a thread, so no run or save inside the workspace ever writes to them.
 *
 * @module assistant/components/BeforeWorkspaces
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { Message } from '@ag-ui/core'
import { getDeploymentSession, listDeploymentSessions } from '../sessions/sessionsApi'
import type { SessionSummary } from '../sessions/schema'

// Not under SESSIONS_QUERY_KEY: a save in the workspace refetches its own list, never this one (nothing writes here).
const BEFORE_WORKSPACES_KEY = ['assistant', 'before-workspaces'] as const

/** The text of a user or assistant message (other roles, and non-text parts, are not shown here). */
function messageText(message: Message): string | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((part: unknown) => {
    const text: unknown = typeof part === 'object' && part !== null ? Reflect.get(part, 'text') : undefined
    return typeof text === 'string' ? [text] : []
  })
  return parts.length > 0 ? parts.join('\n') : null
}

function Transcript({ id }: Readonly<{ id: string }>) {
  const { t } = useTranslation('assistant')
  const record = useQuery({ queryKey: [...BEFORE_WORKSPACES_KEY, id], queryFn: () => getDeploymentSession(id) })
  if (record.isLoading) return <p className="px-2 text-[12px] text-muted">{t('sessions.loading')}</p>
  if (record.isError || !record.data) return <p className="px-2 text-[12px] text-danger" role="alert">{t('sessions.error')}</p>
  const lines = record.data.messages.flatMap((message) => {
    const text = messageText(message)
    return text === null || text.trim() === '' ? [] : [{ id: message.id, role: message.role, text }]
  })
  return (
    <ol className="space-y-2 px-2 pb-2" aria-label={t('sessions.beforeWorkspacesTranscript')}>
      {lines.map((line) => (
        <li key={line.id} className="text-[12px]">
          <span className="font-medium text-text-strong">{line.role === 'user' ? t('export.user') : t('export.assistant')}: </span>
          <span className="whitespace-pre-wrap text-text">{line.text}</span>
        </li>
      ))}
    </ol>
  )
}

function Entry({ session }: Readonly<{ session: SessionSummary }>) {
  const { t } = useTranslation('assistant')
  const [open, setOpen] = useState(false)
  return (
    <li>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer rounded-sm px-2 py-1 text-[13px] text-text focus-ring">
          {session.title === '' ? t('sessions.untitled') : session.title}
        </summary>
        {open && <Transcript id={session.id} />}
      </details>
    </li>
  )
}

function Entries() {
  const { t } = useTranslation('assistant')
  const list = useQuery({ queryKey: BEFORE_WORKSPACES_KEY, queryFn: () => listDeploymentSessions() })
  if (list.isLoading) {
    return <Loader2 size={16} className="mx-auto mt-2 animate-spin text-accent motion-reduce:animate-none" aria-label={t('sessions.loading')} />
  }
  if (list.isError) return <p className="p-2 text-[12px] text-danger" role="alert">{t('sessions.error')}</p>
  if (!list.data || list.data.length === 0) return <p className="p-2 text-[12px] text-muted">{t('sessions.beforeWorkspacesEmpty')}</p>
  return <ul className="space-y-1">{list.data.map((session) => <Entry key={session.id} session={session} />)}</ul>
}

export default function BeforeWorkspaces() {
  const { t } = useTranslation('assistant')
  const [open, setOpen] = useState(false)
  return (
    <details className="mt-3 border-t border-border pt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm px-2 py-1 text-[12px] font-medium text-muted focus-ring">
        {t('sessions.beforeWorkspaces')}
      </summary>
      <p className="px-2 pb-1 text-[12px] text-muted">{t('sessions.beforeWorkspacesHint')}</p>
      {open && <Entries />}
    </details>
  )
}
