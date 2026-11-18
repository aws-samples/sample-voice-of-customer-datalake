/**
 * @fileoverview A question's Logic section (UX §5.2): its rules, in order ("First rule that matches wins"), each a
 * sentence of controls (RuleRow), then the Otherwise line, then "+ Add rule". A statement has only "Then go to".
 * Moving a rule is announced ("Moved rule 2 to position 1 of 3.").
 *
 * @module pages/FeedbackForms/logic/LogicSection
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { useQuestionLogic } from './useQuestionLogic'
import RuleRow from './RuleRow'
import type { RuleFocus } from './RuleRow'
import OtherwiseRow from './OtherwiseRow'

export default function LogicSection({ questionId }: Readonly<{ questionId: string }>) {
  const { t } = useTranslation('feedbackForms')
  const logic = useQuestionLogic(questionId)
  const [focus, setFocus] = useState<{ readonly at: number; readonly on: RuleFocus } | null>(null)
  const [announced, setAnnounced] = useState('')
  const focused = useCallback(() => setFocus(null), [])
  if (logic === null) return null
  const statement = logic.question.type === 'statement'
  const move = (at: number, to: number) => {
    if (to < 0 || to >= logic.rules.length) return
    logic.moveRule(at, to)
    setFocus({ at: to, on: 'operator' })
    setAnnounced(t('logic.moved', { from: at + 1, to: to + 1, total: logic.rules.length }))
  }
  return (
    <div className="space-y-2">
      {!statement && (
        <>
          <p className="text-[12px] text-muted">{t('logic.firstWins')}</p>
          {logic.rules.length > 0 && (
            <ol className="space-y-2" aria-label={t('logic.rulesLabel')}>
              {logic.rules.map((_rule, at) => (
                // (a rule has no id: its position is its identity, and its state lives here)
                <RuleRow key={at} logic={logic} at={at}
                  focus={focus?.at === at ? focus.on : null} onFocused={focused} onMove={(to) => move(at, to)} />
              ))}
            </ol>
          )}
        </>
      )}
      <OtherwiseRow logic={logic} />
      {!statement && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFocus({ at: logic.addRule(), on: 'value' })}>
          <Plus size={14} aria-hidden="true" /> {t('logic.addRule')}
        </button>
      )}
      <p role="status" className="sr-only">{announced}</p>
    </div>
  )
}
