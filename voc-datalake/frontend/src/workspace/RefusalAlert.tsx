/**
 * @fileoverview A failed members, platform console or platform-admin write, said in words: the refusal's own
 * message (`workspaceRefusals.ts`), announced as an alert. Nothing renders without an error.
 *
 * @module workspace/RefusalAlert
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import Notice from '../components/Notice/Notice'
import { workspaceRefusalMessage } from './workspaceRefusals'
import type { Refusal } from './workspaceRefusals'

export default function RefusalAlert({ error, refusals, className }: Readonly<{
  error: unknown
  refusals: readonly Refusal[]
  className?: string
}>) {
  const { t } = useTranslation()
  if (error === null || error === undefined) return null
  const { messageKey, reason } = workspaceRefusalMessage(error, refusals)
  return <Notice variant="banner" tone="danger" role="alert" icon={AlertCircle} text={t(messageKey, { reason })} className={className} />
}
