/**
 * @fileoverview Registry → Agents: the scope's cards (`GET …/registry?connection=`), the roles' own first (every role
 * of the bundle has one, whose id is the role), then the cards made from a skill. Each says what it runs: its skill
 * (the template, or the store's version with its status), its model and (7.58.00) the model chosen for its role, and in
 * `badge-info` when its template is newer
 * than the scope's versions; each opens its page. No made card yet: "No agent cards yet." with Create from a skill.
 *
 * @module pages/Agents/Registry/RegistryCards
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import Notice from '../../../components/Notice/Notice'
import { useModelChoiceText } from '../modelChoiceText'
import { useCardTitle } from './cardTitle'
import { registryCardPath } from './registryPaths'
import type { RegistryCard } from '../../../api/engineeringRegistryApi'

/** What the card runs: the template's label, or the store's version and its status. */
export function SkillLine({ card }: Readonly<{ card: RegistryCard }>) {
  const { t } = useTranslation('agents')
  const { skill } = card
  if (skill.source === 'template' || skill.version === null) {
    return <span>{t('registry.card.skillTemplate', { label: skill.label })}</span>
  }
  const known = skill.status === 'accepted' || skill.status === 'proposed' || skill.status === 'rejected'
  return (
    <span>
      {t('registry.card.skillStore', {
        label: skill.label, version: skill.version, status: known ? t(`skills.status.${skill.status ?? ''}`) : skill.status ?? '',
      })}
    </span>
  )
}

function CardItem({ card, search }: Readonly<{ card: RegistryCard; search: string }>) {
  const { t } = useTranslation('agents')
  const title = useCardTitle()
  const text = useModelChoiceText()
  return (
    <li className="card flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={{ pathname: registryCardPath(card.id), search }} className="link font-semibold"
          aria-label={t('registry.open', { title: title(card) })}>
          {title(card)}
        </Link>
        <span className="font-mono text-[12px] text-muted">{card.id}{card.version === null ? '' : ` v${String(card.version)}`}</span>
        {card.skill.template_newer && card.template !== null && (
          <span className="badge badge-info">{t('skills.template.badge', { version: card.template.version })}</span>
        )}
      </div>
      <p className="text-sm text-text break-words [overflow-wrap:anywhere]">{card.purpose}</p>
      <p className="text-[12px] text-muted break-words [overflow-wrap:anywhere]">
        <SkillLine card={card} />{card.model === '' ? null : <> · <span className="font-mono">{card.model}</span></>}
        {card.model_choice !== null && <> · {t('registry.model.chosen', { model: text.choice(card.model_choice) })}</>}
      </p>
    </li>
  )
}

export function RegistryCards({ cards, search, onCreate }: Readonly<{
  cards: readonly RegistryCard[]; search: string; onCreate: (() => void) | null
}>) {
  const { t } = useTranslation('agents')
  const roles = cards.filter((card) => card.kind === 'role')
  const made = cards.filter((card) => card.kind === 'card')
  return (
    <div className="space-y-6">
      <section aria-labelledby="registry-roles" className="space-y-2">
        <h2 id="registry-roles" className="text-sm font-semibold text-text-strong">{t('registry.roles')}</h2>
        <p className="text-[12px] text-muted">{t('registry.rolesHint')}</p>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {roles.map((card) => <CardItem key={card.id} card={card} search={search} />)}
        </ul>
      </section>
      <section aria-labelledby="registry-made" className="space-y-2">
        <h2 id="registry-made" className="text-sm font-semibold text-text-strong">{t('registry.made')}</h2>
        {made.length === 0 ? (
          <Notice variant="empty" icon={Layers} title={t('registry.empty.title')} text={t('registry.empty.hint')}
            action={onCreate === null ? undefined : { label: t('registry.create.button'), onClick: onCreate }} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {made.map((card) => <CardItem key={card.id} card={card} search={search} />)}
          </ul>
        )}
      </section>
    </div>
  )
}
