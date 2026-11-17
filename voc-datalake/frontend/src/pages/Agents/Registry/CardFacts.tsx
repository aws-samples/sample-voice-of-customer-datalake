/**
 * @fileoverview A Registry card's facts, read only (part 5 "From the card"; §6.4 [52] step 6): a definition list in
 * body text, never disabled inputs. Its skill version and where it came from (the template's in `badge-info`, the
 * coach's in `aim`; "Update available" when the template is newer), linking to that version's document in Skills; its
 * model, tools, harness and caps; what it reads and writes; its gate packs; its scorecard on a connection and the
 * month's spend; and for a card made from a skill, who made it and when.
 *
 * @module pages/Agents/Registry/CardFacts
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { isSkillRole } from '../../../api/engineeringSkillsApi'
import { agentsPath } from '../agentsPaths'
import { useSkillFormats } from '../skillFormats'
import { SkillLine } from './RegistryCards'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import type { CardIo, RegistryCard } from '../../../api/engineeringRegistryApi'

function Fact({ term, children }: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className="contents">
      <dt className="text-[12px] font-semibold text-muted">{term}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere] text-sm text-text">{children}</dd>
    </div>
  )
}

/** The skill version's page in Skills (its scope in the query), or null for the template. */
function skillPathOf(card: RegistryCard): string | null {
  const { skill } = card
  if (skill.version === null || !isSkillRole(card.base_role)) return null
  const path = agentsPath({ view: 'skills', role: card.base_role, version: skill.version })
  const connection = skill.connection ?? ''
  return connection === '' ? path : `${path}?${new URLSearchParams({ connection }).toString()}`
}

function Provenance({ card }: Readonly<{ card: RegistryCard }>) {
  const { t } = useTranslation('agents')
  const { skill } = card
  return (
    <span className="ms-1 inline-flex flex-wrap items-center gap-1 align-middle">
      {skill.provenance === 'template' && skill.template_version !== null && (
        <span className="badge badge-info">{t('registry.card.fromTemplate', { version: skill.template_version })}</span>
      )}
      {skill.provenance === 'coach' && <span className="badge badge-aim">{t('skills.provenance.coach')}</span>}
      {skill.template_newer && card.template !== null && (
        <span className="badge badge-info">{t('skills.template.badge', { version: card.template.version })}</span>
      )}
    </span>
  )
}

function SkillFact({ card }: Readonly<{ card: RegistryCard }>) {
  const { t } = useTranslation('agents')
  const path = skillPathOf(card)
  return (
    <Fact term={t('registry.card.skill')}>
      <SkillLine card={card} />
      <Provenance card={card} />
      {path !== null && <> · <Link to={path} className="link">{t('registry.card.openSkill')}</Link></>}
    </Fact>
  )
}

/** "bug (from hunter.post_subtask, required)", "patch (submitted_patch, recorded on task)". */
function ioText(io: CardIo, t: TFunction<'agents'>): string {
  const parts = [
    io.from === '' ? null : t('registry.card.from', { from: io.from }),
    io.kind === '' ? null : io.kind,
    io.schema === '' ? null : io.schema,
    io.recorded_on === '' ? null : t('registry.card.recordedOn', { on: io.recorded_on }),
    io.required ? t('registry.card.required') : null,
    io.trust === '' ? null : t('registry.card.trust', { trust: io.trust }),
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? io.name : `${io.name} (${parts.join(', ')})`
}

function IoList({ items }: Readonly<{ items: readonly CardIo[] }>) {
  const { t } = useTranslation('agents')
  if (items.length === 0) return <span className="text-muted">—</span>
  return <ul className="space-y-0.5">{items.map((io) => <li key={io.name}>{ioText(io, t)}</li>)}</ul>
}

function UsageFacts({ card }: Readonly<{ card: RegistryCard }>) {
  const { t, i18n } = useTranslation('agents')
  const format = useSkillFormats()
  const money = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' })
  const { scorecard, spend } = card
  return (
    <>
      <Fact term={t('registry.card.scorecard')}>
        {scorecard === null ? <span className="text-muted">{t('registry.card.noScorecard')}</span>
          : t('registry.card.scorecardLine', { runs: scorecard.runs, rate: format.rate(scorecard.pass_rate), cost: money.format(scorecard.cost_usd) })}
      </Fact>
      {spend !== null && (
        <Fact term={t('registry.card.spend')}>{t('registry.card.spendLine', { usd: money.format(spend.usd), month: spend.month })}</Fact>
      )}
    </>
  )
}

export function CardFacts({ card }: Readonly<{ card: RegistryCard }>) {
  const { t, i18n } = useTranslation('agents')
  const format = useSkillFormats()
  const number = new Intl.NumberFormat(i18n.language)
  const caps = Object.entries(card.caps)
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
      <Fact term={t('registry.card.purpose')}>{card.purpose}</Fact>
      <SkillFact card={card} />
      <Fact term={t('registry.card.model')}><span className="font-mono">{card.model}</span></Fact>
      <Fact term={t('registry.card.tools')}><span className="font-mono">{card.tools.join(', ')}</span></Fact>
      <Fact term={t('registry.card.harness')}><span className="font-mono">{card.harness}</span></Fact>
      <Fact term={t('registry.card.caps')}>
        {caps.length === 0 ? <span className="text-muted">—</span>
          : <span className="font-mono">{caps.map(([name, value]) => `${name}: ${number.format(value)}`).join(' · ')}</span>}
      </Fact>
      <Fact term={t('registry.card.inputs')}><IoList items={card.inputs} /></Fact>
      <Fact term={t('registry.card.outputs')}><IoList items={card.outputs} /></Fact>
      {card.gates !== null && <Fact term={t('registry.card.gates')}>{card.gates.packs.join(', ')}</Fact>}
      {card.template !== null && <Fact term={t('registry.card.template')}><span className="font-mono">{card.template.label}</span></Fact>}
      <UsageFacts card={card} />
      {card.kind === 'card' && (
        <Fact term={t('registry.card.made')}>{t('registry.card.madeBy', { who: card.created_by, at: format.at(card.created_at) })}</Fact>
      )}
    </dl>
  )
}
