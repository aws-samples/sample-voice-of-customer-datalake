/**
 * The sections of a persona's detail view.
 *
 * Labels vs status (docs/kiro-design-system.md, rule 15): a persona's attributes —
 * demographics, tech savviness, devices, a scenario's trigger and outcome — are
 * descriptive labels, so every chip is the neutral `badge-muted` and every sub-heading
 * `text-muted`; the lucide icon and the text say which section is which. The one tone
 * kept is `danger` on **Pain points**: that section IS negative sentiment — the
 * persona's challenges and blockers — and sentiment is a state.
 *
 * Empty attributes never print: every value goes through `shownText` / `shownList`
 * (missing, blank and stand-ins such as "undefined" are hidden), and a section with
 * nothing left to show is not rendered at all.
 */
import { useTranslation } from 'react-i18next'
import { BookOpen, Frown, Globe, Quote, Repeat, Target, User } from 'lucide-react'
import PersonaSection from './PersonaSection'
import { scenarioTriggerOutcome } from '../../components/PersonaExportMenu/scenarioTriggerOutcome'
import type { ProjectPersona } from '../../api/projectTypes'
import { humanizeId } from '../../utils/displayLabels'
import { shownList, shownText } from './personaHelpers'

/** A descriptive attribute of the persona: neutral, like every label that says WHICH ONE. */
function AttributeChip({ children }: Readonly<{ children: React.ReactNode }>) {
  return <span className="badge badge-muted whitespace-normal">{children}</span>
}

/** A labelled block of text inside a section: a neutral panel with a muted sub-heading. Nothing when empty. */
function LabelledPanel({ label, text }: Readonly<{ label: string; text: string | null }>) {
  if (text === null) return null
  return (
    <div className="p-3 bg-bg-accent rounded-lg border border-border">
      <p className="text-xs text-muted font-medium mb-1">{label}</p>
      <p className="text-text text-sm">{text}</p>
    </div>
  )
}

/** A paragraph of persona text, or nothing when it is empty. */
function Paragraph({ text, className = 'text-text text-sm' }: Readonly<{ text: string | null; className?: string }>) {
  return text === null ? null : <p className={className}>{text}</p>
}

/** A labelled bullet list inside a section. Nothing when empty. */
function LabelledList({ items, label }: Readonly<{ items: readonly string[]; label: string }>) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-xs text-muted font-medium mb-2">{label}</p>
      <ul className="list-disc list-inside text-text text-sm space-y-1">
        {items.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}
      </ul>
    </div>
  )
}

/** Chips for a list of labels (devices, tools). Nothing when empty. */
function ChipList({ items, label }: Readonly<{ items: readonly string[]; label?: string }>) {
  if (items.length === 0) return null
  const chips = <div className="flex flex-wrap gap-1.5">{items.map((item, i) => <AttributeChip key={`${i}-${item}`}>{item}</AttributeChip>)}</div>
  if (label === undefined) return chips
  return <div><p className="text-xs text-muted font-medium mb-2">{label}</p>{chips}</div>
}

/** Identity attributes with their own translated label; any other key reads as its humanised id. */
const IDENTITY_LABEL_KEYS: Readonly<Record<string, string>> = {
  age_range: 'personaSections.ageRange',
  location: 'personaSections.location',
  occupation: 'personaSections.occupation',
  income_bracket: 'personaSections.incomeBracket',
  education: 'personaSections.education',
  family_status: 'personaSections.familyStatus',
}

export function IdentitySection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const { bio, ...attributes } = persona.identity ?? {}
  const shownBio = shownText(bio)
  const chips = Object.entries(attributes).flatMap(([key, value]) => {
    const text = shownText(value)
    const labelKey = IDENTITY_LABEL_KEYS[key]
    return text === null ? [] : [{ key, label: labelKey === undefined ? humanizeId(key) : t(labelKey), text }]
  })
  if (shownBio === null && chips.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.identityDemographics')} icon={User}>
      <div className="space-y-3">
        <Paragraph text={shownBio} className="text-text text-sm leading-relaxed" />
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => <AttributeChip key={chip.key}>{chip.label}: {chip.text}</AttributeChip>)}
          </div>
        )}
      </div>
    </PersonaSection>
  )
}

export function GoalsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const goals = persona.goals_motivations
  const primary = shownText(goals?.primary_goal)
  const success = shownText(goals?.success_definition)
  const secondary = shownList(goals?.secondary_goals)
  const motivations = shownList(goals?.underlying_motivations)
  if (primary === null && success === null && secondary.length === 0 && motivations.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.goalsMotivations')} icon={Target}>
      <div className="space-y-3">
        <LabelledPanel label={t('personaSections.primaryGoal')} text={primary} />
        <LabelledList items={secondary} label={t('personaSections.secondaryGoals')} />
        <LabelledPanel label={t('personaSections.successDefinition')} text={success} />
        <LabelledList items={motivations} label={t('personaSections.underlyingMotivations')} />
      </div>
    </PersonaSection>
  )
}

export function PainPointsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const pains = persona.pain_points
  const challenges = shownList(pains?.current_challenges)
  const blockers = shownList(pains?.blockers)
  const workarounds = shownList(pains?.workarounds)
  const impact = shownText(pains?.emotional_impact)
  if (challenges.length + blockers.length + workarounds.length === 0 && impact === null) return null

  return (
    // `danger` is earned here: the section is the persona's negative sentiment (state), not a kind.
    <PersonaSection title={t('personaSections.painPoints')} icon={Frown} color="danger">
      <div className="space-y-3">
        <LabelledList items={challenges} label={t('personaSections.currentChallenges')} />
        <LabelledList items={blockers} label={t('personaSections.blockers')} />
        <LabelledList items={workarounds} label={t('personaSections.currentWorkarounds')} />
        <LabelledPanel label={t('personaSections.emotionalImpact')} text={impact} />
      </div>
    </PersonaSection>
  )
}

export function BehaviorsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const behaviors = persona.behaviors
  const solutions = shownList(behaviors?.current_solutions)
  const tools = shownList(behaviors?.tools_used)
  const tech = shownText(behaviors?.tech_savviness)
  const badges = [
    tech === null ? null : `${t('personaSections.techSavviness')}: ${tech}`,
    shownText(behaviors?.activity_frequency),
    shownText(behaviors?.decision_style),
  ].filter((badge): badge is string => badge !== null)
  if (solutions.length + tools.length + badges.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.behaviorsHabits')} icon={Repeat}>
      <div className="space-y-3">
        <LabelledList items={solutions} label={t('personaSections.currentSolutions')} />
        <ChipList items={badges} />
        <ChipList items={tools} label={t('personaSections.toolsUsed')} />
      </div>
    </PersonaSection>
  )
}

export function ContextSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const context = persona.context_environment
  const usage = shownText(context?.usage_context)
  const devices = shownList(context?.devices)
  const time = shownText(context?.time_constraints)
  const social = shownText(context?.social_context)
  const influencers = shownList(context?.influencers)
  if (usage === null && time === null && social === null && devices.length + influencers.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.contextEnvironment')} icon={Globe}>
      <div className="space-y-3">
        <Paragraph text={usage} />
        <ChipList items={devices} />
        <LabelledPanel label={t('personaSections.timeConstraintsLabel')} text={time} />
        <LabelledPanel label={t('personaSections.socialContext')} text={social} />
        <LabelledList items={influencers} label={t('personaSections.influencers')} />
      </div>
    </PersonaSection>
  )
}

export function QuotesSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const quotes = (persona.quotes ?? []).flatMap((q) => {
    const text = shownText(q.text)
    return text === null ? [] : [{ text, context: shownText(q.context) }]
  })
  if (quotes.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.representativeQuotes')} icon={Quote}>
      <div className="space-y-3">
        {quotes.map((q, i) => (
          <blockquote key={`${i}-${q.text}`} className="border-l-4 border-accent/40 pl-4 py-1">
            <p className="text-text text-sm italic">"{q.text}"</p>
            {q.context === null ? null : <p className="text-muted text-xs mt-1">— {q.context}</p>}
          </blockquote>
        ))}
      </div>
    </PersonaSection>
  )
}

export function ScenarioSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  const scenario = persona.scenario
  const title = shownText(scenario?.title)
  const narrative = shownText(scenario?.narrative)
  const parts = scenarioTriggerOutcome({
    trigger: shownText(scenario?.trigger) ?? undefined,
    outcome: shownText(scenario?.outcome) ?? undefined,
  })
  if (title === null && narrative === null && parts === null) return null

  return (
    <PersonaSection title={t('personaSections.scenario')} icon={BookOpen}>
      <div className="space-y-3">
        {title === null ? null : <h4 className="font-medium text-text-strong">{title}</h4>}
        <Paragraph text={narrative} className="text-text text-sm leading-relaxed" />
        {parts === null ? null : (
          <div className="flex flex-col sm:flex-row gap-4 text-sm">
            <div className="flex-1 empty:hidden"><LabelledPanel label={t('personaSections.trigger')} text={parts.trigger} /></div>
            <div className="flex-1 empty:hidden"><LabelledPanel label={t('personaSections.desiredOutcome')} text={parts.outcome} /></div>
          </div>
        )}
      </div>
    </PersonaSection>
  )
}
