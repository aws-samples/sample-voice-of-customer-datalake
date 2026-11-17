/**
 * @fileoverview "From the card <id> v<n>" (7.52.00 C2; docs/ux part 5 §5.4): the setup behind an agent step, always
 * read only (a `bg-bg-accent` panel with a lock, a definition list in body text, never disabled inputs): its
 * purpose, the skill the scope runs (version, provenance, "Template updated"), its model, tools, host, caps, what it
 * reads and writes, its scorecard and this month's spend, from `GET …/registry/<card>?connection=`. A step without a
 * card uses its role's (every role has one). A card the Registry does not have says so; a failed read says so with
 * Retry inside this section only (the flow's own fields stay editable).
 *
 * @module components/WorkflowEditor/inspector/FromCard
 */
import { ExternalLink, Lock } from 'lucide-react'
import { Link } from 'react-router-dom'
import i18n from 'i18next'
import { useTranslation } from 'react-i18next'
import { formatDecimal } from '../../../utils/numberFormat'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import LoadFailed from '../../LoadFailed/LoadFailed'
import { registryCardPath } from '../../../pages/Agents/Registry/registryPaths'
import { modelShortName } from '../nodes/nodeText'
import { Facts, SectionHeading, SectionLoading } from './InspectorShell'
import { useCanReadSetup, useRegistryCard } from './useFlowSetup'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { RegistryCard } from '../../../api/flowSetupApi'

/** At most this many tools are named; the rest are "+N". */
const MAX_TOOLS = 5

function listed(items: readonly string[], max = MAX_TOOLS): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max}`
}

type Row = readonly [string, ReactNode] | null

function skillRow(t: TFunction<'agents'>, card: RegistryCard): Row {
  const skill = card.skill
  const version = skill.version ?? skill.template_version
  return [t('inspector.agent.skill'), (
    <span key="skill">
      {version === null ? skill.label : t('inspector.agent.skillVersion', { version, provenance: skill.provenance ?? skill.source })}
      {skill.template_newer && <span className="badge badge-info ml-1.5">{t('canvas.chips.updateAvailable')}</span>}
    </span>
  )]
}

function capsRow(t: TFunction<'agents'>, card: RegistryCard): Row {
  const turns = card.caps.max_turns
  const tokens = card.caps.max_input_tokens
  const parts = [
    typeof turns === 'number' ? t('inspector.agent.turns', { n: turns }) : '',
    typeof tokens === 'number' ? t('inspector.agent.tokens', { n: Math.round(tokens / 1000) }) : '',
  ].filter((part) => part !== '')
  return parts.length === 0 ? null : [t('inspector.agent.caps'), parts.join(' · ')]
}

function usageRows(t: TFunction<'agents'>, card: RegistryCard): Row[] {
  const score = card.scorecard
  return [
    score === null ? null : [t('inspector.agent.scorecard'), t('inspector.agent.scorecardLine', {
      runs: score.runs, rate: Math.round((score.pass_rate ?? 0) * 100),
    })],
    card.spend === null ? null : [t('inspector.agent.thisMonth'), t('inspector.agent.usd', { amount: formatDecimal(card.spend.usd, i18n.language, 2) })],
  ]
}

const namesOf = (items: readonly { name: string }[]): string => items.map((item) => item.name).join(', ')

function cardRows(t: TFunction<'agents'>, card: RegistryCard): Row[] {
  const host = card.broker_ops.length === 0 ? card.harness : t('inspector.agent.hostBroker', { ops: card.broker_ops.join(', ') })
  return [
    card.purpose === '' ? null : [t('inspector.agent.purpose'), card.purpose],
    skillRow(t, card),
    card.model === '' ? null : [t('inspector.agent.model'), modelShortName(card.model)],
    card.tools.length === 0 ? null : [t('inspector.agent.tools'), listed(card.tools)],
    [t('inspector.agent.host'), host],
    capsRow(t, card),
    card.inputs.length === 0 ? null : [t('inspector.agent.reads'), namesOf(card.inputs)],
    card.outputs.length === 0 ? null : [t('inspector.agent.writes'), namesOf(card.outputs)],
    ...usageRows(t, card),
  ]
}

function CardFacts({ card }: Readonly<{ card: RegistryCard }>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <Facts rows={cardRows(t, card)} />
      <Link to={registryCardPath(card.id)} className="btn btn-ghost btn-sm">
        {t('inspector.openCard')} <ExternalLink size={12} aria-hidden="true" />
      </Link>
    </>
  )
}

/** The card panel's body for its read: on its way, not in the Registry, failed (Retry), or the card. */
function CardBody({ cardId, version, connection }: Readonly<{ cardId: string; version: number | null; connection: string | null }>) {
  const { t } = useTranslation('agents')
  const read = useRegistryCard(cardId, connection)
  if (read.isLoading) return <SectionLoading />
  if (read.data !== undefined) return <CardFacts card={read.data} />
  if (apiErrorStatus(read.error) === 404) {
    return (
      <p role="note" className="rounded-md bg-warn-subtle px-2 py-1.5 text-[12px] text-text">
        {t('inspector.empty.cardMissing', { card: version === null ? cardId : `${cardId} v${version}` })}
      </p>
    )
  }
  return <LoadFailed onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
}

/** The read-only panel of the card behind a step (`cardId`: its made card, else its role). */
export function FromCard({ cardId, version, connection }: Readonly<{
  cardId: string | undefined; version: number | null; connection: string | null
}>) {
  const { t } = useTranslation('agents')
  const allowed = useCanReadSetup()
  if (cardId === undefined) return null
  return (
    <section className="space-y-2 rounded-md bg-bg-accent p-3" aria-label={t('inspector.fromCardLabel')}>
      <SectionHeading action={<span className="inline-flex items-center gap-1 text-[12px] text-muted"><Lock size={14} aria-hidden="true" /> {t('inspector.readOnlyShort')}</span>}>
        {version === null ? t('inspector.fromCardAny', { card: cardId }) : t('inspector.fromCard', { card: cardId, n: version })}
      </SectionHeading>
      {allowed ? <CardBody cardId={cardId} version={version} connection={connection} />
        : <p className="text-[12px] text-muted">{t('inspector.empty.cardAdmins')}</p>}
    </section>
  )
}
