/**
 * @fileoverview The builder's tabs (UX §3.1): Questions · Flow · Languages · Hidden fields · Test · Share · Results ·
 * Settings, as `IconTabs` in a scrolling rail. A tab with problems shows a 6 px dot and says it in sr-only text
 * ("Languages, 4 missing translations").
 *
 * @module pages/FeedbackForms/builder/BuilderTabs
 */
import { useTranslation } from 'react-i18next'
import { BarChart3, EyeOff, FlaskConical, GitBranch, Languages, ListOrdered, Settings2, Share2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { IconTabs } from '../../../components/IconTabs/IconTabs'
import { tabProblemCount } from './tabState'
import { BUILDER_TABS } from './builderPaths'
import type { BuilderTab } from './builderPaths'
import { useDraft } from './formDraftContext'

const ICONS: Readonly<Record<BuilderTab, LucideIcon>> = {
  questions: ListOrdered,
  flow: GitBranch,
  languages: Languages,
  'hidden-fields': EyeOff,
  test: FlaskConical,
  share: Share2,
  results: BarChart3,
  settings: Settings2,
}

export default function BuilderTabs({ active, onSelect }: Readonly<{ active: BuilderTab; onSelect: (tab: BuilderTab) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const { problems } = useDraft()
  const labelOf = (tab: BuilderTab) => {
    const count = tabProblemCount(tab, problems)
    return (
      <>
        <span>{t(`builder.tabs.${tab}`)}</span>
        {count > 0 && (
          <>
            <span aria-hidden="true" className={tab === 'languages' ? 'h-1.5 w-1.5 rounded-full bg-warn' : 'h-1.5 w-1.5 rounded-full bg-danger'} />
            <span className="sr-only">
              {', '}{tab === 'languages' ? t('builder.tabs.withMissing', { count }) : t('builder.tabs.withProblems', { count })}
            </span>
          </>
        )}
      </>
    )
  }
  return <IconTabs tabs={BUILDER_TABS} active={active} icons={ICONS} label={t('builder.tabs.label')} labelOf={labelOf} onSelect={onSelect} />
}
