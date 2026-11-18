/**
 * @fileoverview Registry → **Quality gates** (`/agents/registry/gates`; the owner moved Quality gates into the
 * Registry as a filter): the gate packs a quality gate runs (`GET …/gates?connection=`), read only, each with its
 * languages, image pins, setup network, tools ("The repository's own pins", and with a connection the versions its
 * newest gate record holds), its steps (what each runs, when it applies, how it fails when it looked at nothing) and
 * the owner's brief, read on the shared document component only when opened (GateBrief.tsx, gap N). Then when a gate
 * stops at a person, and who runs a gate that names nobody.
 *
 * @module pages/Agents/Registry/QualityGates
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReadPending from '../../../components/LoadFailed/ReadPending'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import { useConfigStore } from '../../../store/configStore'
import { GateBriefPanel } from './GateBrief'
import type { ReactNode } from 'react'
import type { GateBrief, GatePack, GateStep, GateStop, QualityGates as Gates } from '../../../api/engineeringRegistryApi'

/** A marker's words: `{file: 'pom.xml'}` → `pom.xml`. */
const markerText = (marker: Readonly<Record<string, unknown>>) =>
  Object.values(marker).map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')

function Row({ term, children }: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className="contents">
      <dt className="text-[12px] font-semibold text-muted">{term}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere] text-sm">{children}</dd>
    </div>
  )
}

function StepItem({ step }: Readonly<{ step: GateStep }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="space-y-0.5 rounded-md border border-border p-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="badge badge-muted">{step.kind}</span>
        <span className="font-mono text-[12px] break-all">{step.name}</span>
        <span className="text-[12px] text-muted">
          {step.when_any.length === 0 ? t('gates.stepAlways') : t('gates.stepWhen', { list: step.when_any.map(markerText).join(', ') })}
        </span>
      </p>
      {step.looked_at_nothing !== null && <p className="text-[12px] text-muted">{t('gates.lookedAtNothing', { rule: step.looked_at_nothing })}</p>}
    </li>
  )
}

function ToolsLine({ pack }: Readonly<{ pack: GatePack }>) {
  const { t } = useTranslation('agents')
  const recorded = pack.recorded === null ? [] : Object.entries(pack.recorded.tool_versions)
  return (
    <>
      <span className="font-mono">{pack.tools.map((tool) => tool.name).join(', ')}</span>{' · '}
      {recorded.length === 0 ? t('gates.toolsPins')
        : t('gates.toolsRecorded', { list: recorded.map(([name, version]) => `${name} ${version}`).join(', ') })}
    </>
  )
}

function PackCard({ pack, briefs }: Readonly<{ pack: GatePack; briefs: readonly GateBrief[] }>) {
  const { t } = useTranslation('agents')
  const image = Object.entries(pack.image)
  const own = briefs.filter((brief) => pack.briefs.includes(brief.id))
  return (
    <li className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-text-strong">{pack.name === '' ? pack.id : pack.name}</h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
        <Row term={t('gates.languages')}>{pack.languages.join(', ')}</Row>
        {image.length > 0 && <Row term={t('gates.image')}><span className="font-mono">{image.map(([name, pin]) => `${name} ${pin}`).join(' · ')}</span></Row>}
        {pack.network.length > 0 && <Row term={t('gates.network')}><span className="font-mono">{pack.network.join(', ')}</span></Row>}
        {pack.tools.length > 0 && <Row term={t('gates.tools')}><ToolsLine pack={pack} /></Row>}
      </dl>
      <section aria-label={t('gates.stepsOf', { pack: pack.name === '' ? pack.id : pack.name })} className="space-y-1">
        <h4 className="text-[12px] font-semibold text-muted">{t('gates.steps')}</h4>
        <ol className="space-y-1">{pack.steps.map((step) => <StepItem key={step.id} step={step} />)}</ol>
      </section>
      {own.map((brief) => <GateBriefPanel key={brief.id} brief={brief} headingLevel={3} />)}
    </li>
  )
}

/** The stop's words in the reader's language (the server's English when this release has no words for its code). */
function StopText({ stop, ownGate }: Readonly<{ stop: GateStop; ownGate: string }>) {
  const { t } = useTranslation('agents')
  return <>{t(`gates.stops.${stop.code}`, { own_gate: ownGate, defaultValue: stop.text })}</>
}

function GateFacts({ gates }: Readonly<{ gates: Gates }>) {
  const { t } = useTranslation('agents')
  const ownGate = gates.ownGate?.file ?? ''
  return (
    <section aria-labelledby="gate-stops" className="space-y-2">
      <h2 id="gate-stops" className="text-sm font-semibold text-text-strong">{t('gates.stopsTitle')}</h2>
      <ul className="list-disc space-y-1 ps-5 text-sm">
        {gates.stops.map((stop) => <li key={stop.code}><StopText stop={stop} ownGate={ownGate} /></li>)}
      </ul>
      {Object.keys(gates.defaults).length > 0 && (
        <p className="text-[12px] text-muted">{t('gates.runners', { list: Object.values(gates.defaults).join(', ') })}</p>
      )}
    </section>
  )
}

export function QualityGates({ connection }: Readonly<{ connection: string }>) {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({
    queryKey: engineeringRegistryKeys.gates(connection), queryFn: () => engineeringRegistryApi.gates(connection), enabled: configured,
    staleTime: 5 * 60_000,
  })
  if (read.isLoading || read.isError || read.data === undefined) {
    return <ReadPending read={read} loading={t('gates.loading')} failed={t('gates.failed')} skeleton="h-32" />
  }
  const gates = read.data
  return (
    <div className="space-y-6" aria-busy={read.isFetching}>
      <p className="max-w-prose text-sm text-muted">{t('gates.hint')}</p>
      {gates.ownGate !== null && <p className="text-sm">{t('gates.ownGate', { file: gates.ownGate.file })}</p>}
      <ul aria-label={t('gates.packs')} className="grid gap-4 lg:grid-cols-2">
        {gates.packs.map((pack) => <PackCard key={pack.id} pack={pack} briefs={gates.briefs} />)}
      </ul>
      <GateFacts gates={gates} />
    </div>
  )
}
