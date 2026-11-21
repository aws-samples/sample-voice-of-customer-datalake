/**
 * @fileoverview Administration → Engineering agents (`/admin/agents`, 7.59.00): the deployment-wide settings of the
 * autonomous engineering agents, gathered on one tab (they stay where they are edited too):
 *
 * - **Hard cap** (`#hard-cap`): Agents › Spend's opt-in switch (EngineeringHardCap.tsx, the same card and query);
 * - **Roles' models** (`#models`): each role, the harness this deployment runs it on (Kiro or the native harness) and
 *   the model it runs on (`GET /agents/engineering/registry`, the Registry's own read), each linked to its Registry
 *   card, where the model is chosen (7.58.00);
 * - **GitHub connections** (`#connections`): where GitHub is connected (the App, a fine-grained token or a fork), the
 *   spend and the setup guide. The fine-grained tokens to replace are "Needs attention"'s, which leads to Agents →
 *   Connections, where each is replaced (7.66.00).
 *
 * Shown to administrators while the Agents page and the engineering module are on (adminTabs.ts).
 *
 * @module pages/Settings/EngineeringAgentsTab
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Cpu, KeyRound } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import type { RegistryCard } from '../../api/engineeringRegistryApi'
import { EngineeringHardCap } from '../Agents/EngineeringHardCap'
import { agentsPath } from '../Agents/agentsPaths'
import { useModelChoiceText } from '../Agents/modelChoiceText'
import { useCardTitle } from '../Agents/Registry/cardTitle'
import { registryCardPath } from '../Agents/Registry/registryPaths'
import { useRegistryList } from '../Agents/Registry/useRegistryList'
import { setupGuidePath } from '../Agents/SetupGuide/setupGuidePaths'
import { SectionHeader } from '../Company/ContextParts'
import { CardAnchor } from './CardAnchor'

/** The shared skills' scope of the Registry ('': no connection). */
const SHARED = ''

/** One role: its name, the harness it runs on here and its model in words, and the link to its Registry card. */
function RoleRow({ card }: Readonly<{ card: RegistryCard }>) {
  const { t } = useTranslation('settings')
  const text = useModelChoiceText()
  const title = useCardTitle()(card)
  const model = card.model_choice === null ? t('agentsTab.roleDefault', { model: text.model(card.model) }) : text.choice(card.model_choice)
  return (
    <li className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,12rem)_auto] sm:items-center sm:gap-4">
      <span className="min-w-0 break-words font-medium text-text-strong">{title}</span>
      <span><span className="badge badge-muted">{t(`agents:modelChoice.harness.${card.runs_on}`)}</span></span>
      <span className="min-w-0 break-words text-sm text-text">{model}</span>
      <Link to={registryCardPath(card.id)} className="link text-sm" aria-label={t('agentsTab.changeModel', { role: title })}>
        {t('agentsTab.change')}
      </Link>
    </li>
  )
}

function RoleModelsCard() {
  const { t } = useTranslation('settings')
  const read = useRegistryList(SHARED)
  const roles = (read.data ?? []).filter((card) => card.kind === 'role')
  return (
    <section className="card">
      <SectionHeader icon={Cpu} title={t('sections.models')} description={t('agentsTab.modelsDescription')} />
      {read.isError ? (
        <LoadFailed message={t('agentsTab.modelsUnread')} onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
      ) : (
        <ul className="divide-y divide-border" aria-busy={read.isLoading}>
          {roles.map((card) => <RoleRow key={card.id} card={card} />)}
        </ul>
      )}
    </section>
  )
}

function ConnectionsCard() {
  const { t } = useTranslation('settings')
  const links = [
    { to: agentsPath({ view: 'connections' }), label: t('agentsTab.links.connections'), hint: t('agentsTab.links.connectionsHint') },
    { to: agentsPath({ view: 'spend' }), label: t('agentsTab.links.spend'), hint: t('agentsTab.links.spendHint') },
    { to: setupGuidePath(), label: t('agentsTab.links.setup'), hint: t('agentsTab.links.setupHint') },
  ]
  return (
    <section className="card">
      <SectionHeader icon={KeyRound} title={t('sections.connections')} description={t('agentsTab.connectionsDescription')} />
      <ul className="divide-y divide-border">
        {links.map((link) => (
          <li key={link.to} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
            <Link to={link.to} className="link font-medium sm:w-56 sm:flex-shrink-0">{link.label}</Link>
            <span className="text-sm text-muted">{link.hint}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function EngineeringAgentsTab() {
  return (
    <>
      <CardAnchor card="hard-cap"><EngineeringHardCap /></CardAnchor>
      <CardAnchor card="models"><RoleModelsCard /></CardAnchor>
      <CardAnchor card="connections"><ConnectionsCard /></CardAnchor>
    </>
  )
}
