/**
 * @fileoverview The workflow editor's hooks and rules beside its toolbar (7.52.00 C2): whether Save as is offered,
 * the automations' names as a list, what the palette is built from, and whether the screen docks the inspector.
 *
 * @module components/WorkflowEditor/editorHooks
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isEngineeringFlow } from '../../api/workflowsApi'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { noCleanup } from '../../hooks/noCleanup'
import { useFlowLibrary, useGatePacks, useRegistryCards } from './inspector/useFlowSetup'
import type { UsingAutomation, WorkflowDefinition, WorkflowUsedBy } from '../../api/workflowsApi'
import type { PaletteSources } from './paletteItems'

/**
 * Whether Save as (a NEW workflow) is offered: an engineering flow only where the deployment has the engineering
 * module (the API answers 409 elsewhere); one already saved is still saved in place. The toolbar's and the stale-save
 * banner's Save as both ask.
 */
export const savesAsNew = (draft: WorkflowDefinition): boolean => !isEngineeringFlow(draft) || isEngineeringAvailable()

/** The automations' names as a list in the person's language ("Bug fixer and Feature builder"). */
export function useNames(automations: readonly UsingAutomation[]): string {
  const { i18n } = useTranslation('agents')
  return useMemo(() => {
    const names = automations.map((automation) => automation.name || automation.agent_id)
    try {
      return new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(names)
    } catch {
      return names.join(', ')
    }
  }, [automations, i18n.language])
}

/** What an engineering flow's palette offers, each part where it can be read (an administrator, the module on). */
export function usePaletteSources(draft: WorkflowDefinition, workflowId: string, usedBy: WorkflowUsedBy): PaletteSources | undefined {
  const engineering = isEngineeringFlow(draft)
  const cards = useRegistryCards(null, engineering)
  const gates = useGatePacks(null, engineering)
  const flows = useFlowLibrary(engineering)
  return useMemo(() => (engineering
    ? { cards: cards.data, gates: gates.data, flows: flows.data, workflowId, usedBy } : undefined),
  [engineering, cards.data, gates.data, flows.data, workflowId, usedBy])
}

/** Below the docked inspector's breakpoint (`lg`, 1024 px). Asked as "narrow", so where nothing answers it is wide. */
const NARROW = '(max-width: 1023.98px)'

const narrowQuery = (): MediaQueryList | null => ('matchMedia' in globalThis ? globalThis.matchMedia(NARROW) : null)

/** Whether the screen is wide enough to dock the inspector (wide where it cannot be asked: a server render). */
export function useWideScreen(): boolean {
  const [wide, setWide] = useState(() => narrowQuery()?.matches !== true)
  useEffect(() => {
    const query = narrowQuery()
    if (query === null) return noCleanup
    const follow = () => setWide(!query.matches)
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [])
  return wide
}
