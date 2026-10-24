/**
 * @fileoverview A decision's verdict: a STATE, so it carries a status tone and its icon
 * (docs/kiro-design-system.md rule 15) — pursue ok, park warn, reject danger.
 * @module pages/ProjectDetail/decisions/VerdictBadge
 */
import { CirclePause, CircleX, Rocket } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Verdict } from '../../../api/decisionSchema'
import type { Tone } from '../../../theme/tones'

const VERDICT_STYLE: Readonly<Record<Verdict, { tone: Tone; icon: LucideIcon }>> = {
  pursue: { tone: 'ok', icon: Rocket },
  park: { tone: 'warn', icon: CirclePause },
  reject: { tone: 'danger', icon: CircleX },
}

export default function VerdictBadge({ verdict }: Readonly<{ verdict: Verdict }>) {
  const { t } = useTranslation('decisions')
  const { tone, icon: Icon } = VERDICT_STYLE[verdict]
  return (
    <span className={`badge badge-${tone} inline-flex items-center gap-1`}>
      <Icon size={12} aria-hidden />
      {t(`verdict.${verdict}`)}
    </span>
  )
}
