/**
 * @fileoverview Who a pin's reply is from, in the pins panel and the Feedback dialog alike: a person's name,
 * or, for a reason an incorporation wrote (docs/prototype-builder.md part 3, `kind: 'ai'`), "AI reason, approved
 * by an editor" — the model's words, never shown as the applier's own (the server names the approver by id only).
 * @module components/PrototypePins/ReplyAuthor
 */
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { z } from 'zod'
import type { PinReplySchema } from '../../api/prototypePinsApi'

type PinReply = z.infer<typeof PinReplySchema>

export default function ReplyAuthor({ reply }: Readonly<{ reply: PinReply }>) {
  const { t } = useTranslation('components')
  if (reply.kind === 'ai') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-muted-strong" data-testid="ai-reply-author">
        <Sparkles size={11} aria-hidden /> {t('prototypeFeedback.aiReason')}
      </span>
    )
  }
  return <span className="font-medium">{reply.name || t('prototypeFeedback.someone')}</span>
}
