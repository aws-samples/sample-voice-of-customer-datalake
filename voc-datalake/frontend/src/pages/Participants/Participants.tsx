/**
 * @fileoverview Participants (docs/participants.md): the people we can email to ask for
 * feedback — employees, paid participants, beta customers, sales colleagues — grouped in
 * lists, and the asks sent to them.
 *
 * Tabs (`?tab=lists|people|asks`, Lists is the default and no param, `useTabParam`): one top tab bar,
 * the Memory / Company recipe. "New ask" opens the composer from any tab.
 *
 * @module pages/Participants
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Contact, List, Mail, Send } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { useConfigStore } from '../../store/configStore'
import AskComposer from './AskComposer'
import AsksList from './AsksList'
import ListsTab from './ListsTab'
import PeopleTab from './PeopleTab'
import { useTabParam } from './useTabParam'

const PARTICIPANT_TABS = ['lists', 'people', 'asks'] as const
type ParticipantTab = typeof PARTICIPANT_TABS[number]

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
  const [tab, setTab] = useTabParam(PARTICIPANT_TABS)
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

      <div className="tabs-rail overflow-x-auto">
        <div className="tabs-track" role="tablist" aria-label={t('page.title')}>
          {PARTICIPANT_TABS.map((id) => {
            const Icon = TAB_ICONS[id]
            return (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={clsx('tab', tab === id && 'tab-active')}>
                <Icon size={14} aria-hidden />
                <TabLabel tab={id} />
              </button>
            )
          })}
        </div>
      </div>

      {configured ? <TabContent tab={tab} /> : (
        <div className="card text-sm text-warn bg-warn-subtle border-warn/30">{t('configureFirst')}</div>
      )}
      {composing ? <AskComposer onClose={() => setComposing(false)} /> : null}
    </div>
  )
}
