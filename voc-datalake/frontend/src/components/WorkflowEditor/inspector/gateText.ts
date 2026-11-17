/**
 * @fileoverview A gate's packs in words (7.52.00 C2): when a pack's step applies ("if pom.xml is there or if
 * pyproject.toml has [tool.ruff"), and which packs a gate runs (the ones it names, an alias of before 7.50.00 for
 * its two, else every pack).
 *
 * @module components/WorkflowEditor/inspector/gateText
 */
import type { TFunction } from 'i18next'
import type { GatePack, GateStep, GatesView } from '../../../api/flowSetupApi'


/** When a step applies, in words: "if pom.xml is there or if pyproject.toml has [tool.ruff", or always. */
export function whenWords(t: TFunction<'agents'>, step: GateStep): string {
  if (step.when_any.length === 0) return t('inspector.gate.always')
  return step.when_any.map((when) => {
    if (when.npm_script !== '') return t('inspector.gate.whenScript', { file: when.file, script: when.npm_script })
    if (when.contains !== '') return t('inspector.gate.whenContains', { file: when.file, text: when.contains })
    return t('inspector.gate.whenFile', { file: when.file })
  }).join(t('inspector.gate.or'))
}

/** The packs a gate runs: the ones it names (an alias of before 7.50.00 stands for its two), else every pack. */
export function gatePacksOf(packs: unknown, gates: GatesView): GatePack[] {
  if (!Array.isArray(packs)) return gates.packs
  const ids = new Set(packs.flatMap((id: unknown) => (typeof id === 'string' ? gates.aliases[id] ?? [id] : [])))
  return gates.packs.filter((pack) => ids.has(pack.id))
}

