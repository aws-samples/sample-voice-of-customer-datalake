/**
 * @fileoverview Participants (docs/participants.md): the people we can email to ask for
 * feedback — employees, paid participants, beta customers, sales colleagues — grouped in
 * lists, and the asks sent to them.
 *
 * Tabs as paths (`/participants/lists` (`/participants` too), `/participants/people`, `/participants/asks`;
 * utils/tabPaths.ts; an unknown tab is replaced by Lists): one top tab bar, the Memory / Company recipe. "New ask" opens the composer from any tab.
 *
 * @module pages/Participants
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import { Contact, List, Mail, Send } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { useConfigStore } from '../../store/configStore'
import AskComposer from './AskComposer'
import AsksList from './AsksList'
import ListsTab from './ListsTab'
import PeopleTab from './PeopleTab'
import { useTabPath } from '../../utils/tabPaths'
import { PARTICIPANTS_PAGE, PARTICIPANT_TABS } from './participantsPaths'
import type { ParticipantTab } from './participantsPaths'

const TAB_ICONS: Readonly<Record<ParticipantTab, LucideIcon>> = { lists: List, people: Contact, asks: Mail }

function TabLabel({ tab }: Readonly<{ tab: ParticipantTab }>) {
  const { t } = useTranslation('participants')
  switch (tab) {
    case 'lists': return <>{t('tabs.lists')}</>
    case 'people': return <>{t('tabs.people')}</>
    case 'asks': return <>{t('tabs.asks')}</>
  }
}

function TabContent({ tab }: Readonly<{ tab: ParticipantTab }>) {
  switch (tab) {
    case 'lists': return <ListsTab />
    case 'people': return <PeopleTab />
    case 'asks': return <AsksList />
  }
}

export default function Participants() {
  const { t } = useTranslation('participants')
  const { config } = useConfigStore()
  const configured = Boolean(config.apiEndpoint)
  const [tab, setTab] = useTabPath(PARTICIPANTS_PAGE)
  const [composing, setComposing] = useState(false)

  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageTitle title={t('page.title')} subtitle={t('page.subtitle')} />
        {configured ? (
          <button type="button" onClick={() => setComposing(true)} className="btn btn-primary self-start">
            <Send size={14} aria-hidden /> {t('composer.open')}
          </button>
        ) : null}
      </div>

      <IconTabs tabs={PARTICIPANT_TABS} active={tab} icons={TAB_ICONS} label={t('page.title')}
        labelOf={(id) => <TabLabel tab={id} />} onSelect={setTab} />

      {configured ? <TabContent tab={tab} /> : (
        <div className="card text-sm text-warn bg-warn-subtle border-warn/30">{t('configureFirst')}</div>
      )}
      {composing ? <AskComposer onClose={() => setComposing(false)} /> : null}
    </div>
  )
}
