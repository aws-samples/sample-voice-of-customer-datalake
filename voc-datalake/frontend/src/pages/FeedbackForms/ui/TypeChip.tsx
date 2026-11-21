/**
 * @fileoverview A question type's chip: a descriptive label, so `badge-muted` with the type's icon (R15). The icons
 * and names are `ui/typeIcons.ts`'s.
 *
 * @module pages/FeedbackForms/ui/TypeChip
 */
import { createElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { Question } from '../model/formsV2'
import { questionIcon, typeNameKey } from './typeIcons'

export default function TypeChip({ question, count }: Readonly<{
  question: Pick<Question, 'type'> & { readonly long?: boolean }
  /** "×2": how many questions of this type (the picker's cards). */
  count?: number
}>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <span className="badge badge-muted inline-flex items-center gap-1">
      {createElement(questionIcon(question), { size: 12, 'aria-hidden': true })}
      {t(typeNameKey(question))}
      {count !== undefined && count > 1 && <span className="font-mono">×{count}</span>}
    </span>
  )
}
