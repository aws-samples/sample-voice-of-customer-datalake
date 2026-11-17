/**
 * @fileoverview A quality gate's packs, read only (7.52.00 C2; docs/ux part 5 §5.4 "Gate"): each pack the gate runs
 * (the ones it names; with Auto-detect, the pack each automation's language picks, or every pack while no automation
 * uses the flow) with its image pins, the registries its setup reaches, its steps in words ("ruff check: if ruff.toml
 * is there", and how a step fails when it looked at nothing), its tools' versions (the repository's own pins, and the
 * last a connection's gate recorded) and the owner's brief, read when opened and shown in the shared document
 * component (`DocumentSurface`, `panel`, read mode). From `GET …/gates?connection=`.
 *
 * @module components/WorkflowEditor/inspector/GatePacks
 */
import { Suspense, lazy, useState } from 'react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../LoadFailed/LoadFailed'
import { Facts, SectionLoading } from './InspectorShell'
import { useGatePacks } from './useFlowSetup'
import { gatePacksOf, whenWords } from './gateText'
import type { TFunction } from 'i18next'
import type { GateBrief, GatePack, GatesView } from '../../../api/flowSetupApi'
import type { UsingAutomation } from '../../../api/workflowsApi'


/** With Auto-detect, the pack each automation's language picks ("For Bug fixer: Python"). */
function detectedFor(t: TFunction<'agents'>, automations: readonly UsingAutomation[], gates: GatesView): string[] {
  return automations.flatMap((automation) => {
    const language = automation.language ?? ''
    const pack = gates.packs.find((each) => each.id === language || each.languages.includes(language))
    return pack === undefined ? [] : [t('inspector.gate.forAutomation', { automation: automation.name, pack: pack.name || pack.id })]
  })
}

/** The brief in the shared document component, loaded when a brief is first opened (it brings the document engine). */
const GateBriefDocument = lazy(() => import('./GateBriefDocument'))

function BriefToggle({ brief }: Readonly<{ brief: GateBrief }>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[13px] text-text">{t('inspector.gate.briefOpen', { path: brief.path })}</summary>
      {open && <div className="mt-2"><Suspense fallback={<SectionLoading />}><GateBriefDocument brief={brief} /></Suspense></div>}
    </details>
  )
}

function PackSteps({ pack }: Readonly<{ pack: GatePack }>) {
  const { t } = useTranslation('agents')
  return (
    <ul className="space-y-1">
      {pack.steps.map((step) => (
        <li key={step.id} className="text-[13px]">
          <span className="badge badge-muted mr-1.5">{t(`inspector.gate.stepKinds.${step.kind}`, { defaultValue: step.kind })}</span>
          <span className="text-text">{step.name}</span>
          <span className="text-muted">: {whenWords(t, step)}</span>
          {step.looked_at_nothing !== null && <span className="block text-[12px] text-muted">{t('inspector.gate.lookedAtNothing')}</span>}
        </li>
      ))}
    </ul>
  )
}

function PackSection({ pack, briefs }: Readonly<{ pack: GatePack; briefs: readonly GateBrief[] }>) {
  const { t } = useTranslation('agents')
  const image = Object.entries(pack.image).map(([name, version]) => `${name} ${version}`).join(' · ')
  const recorded = pack.recorded === null ? '' : Object.entries(pack.recorded.tool_versions).map(([tool, version]) => `${tool} ${version}`).join(', ')
  const own = briefs.filter((brief) => pack.briefs.includes(brief.id))
  return (
    <details className="rounded-md border border-border p-2">
      <summary className="cursor-pointer text-[13px] font-medium text-text-strong">{t('inspector.gate.pack', { name: pack.name || pack.id })}</summary>
      <div className="mt-2 space-y-2">
        <Facts rows={[
          image === '' ? null : [t('inspector.gate.image'), image],
          pack.network.length === 0 ? null : [t('inspector.gate.network'), pack.network.join(', ')],
          [t('inspector.gate.tools'), recorded === '' ? t('inspector.gate.ownPins') : t('inspector.gate.ownPinsRecorded', { list: recorded })],
        ]} />
        <p className="text-[12px] font-medium text-muted">{t('inspector.gate.steps')}</p>
        <PackSteps pack={pack} />
        {own.map((brief) => <BriefToggle key={brief.id} brief={brief} />)}
      </div>
    </details>
  )
}

export function GatePacks({ packs, automations, connection }: Readonly<{
  packs: unknown; automations: readonly UsingAutomation[]; connection: string | null
}>) {
  const { t } = useTranslation('agents')
  const gates = useGatePacks(connection)
  const view = gates.data
  if (gates.isLoading) return <SectionLoading />
  if (view === undefined) {
    return gates.isError ? <LoadFailed onRetry={() => { void gates.refetch() }} retrying={gates.isFetching} />
      : <p className="text-[12px] text-muted">{t('inspector.empty.cardAdmins')}</p>
  }
  const auto = !Array.isArray(packs)
  const detected = auto ? detectedFor(t, automations, view) : []
  return (
    <div className="space-y-2">
      {auto && detected.length === 0 && <p className="text-[12px] text-muted">{t('inspector.empty.autoDetect')}</p>}
      {detected.map((line) => <p key={line} className="text-[13px] text-text">{line}</p>)}
      {gatePacksOf(packs, view).map((pack) => <PackSection key={pack.id} pack={pack} briefs={view.briefs} />)}
    </div>
  )
}
