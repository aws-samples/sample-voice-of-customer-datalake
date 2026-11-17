/**
 * @fileoverview The flow canvas's reads of the setup behind its steps (7.52.00 C2; docs/ux part 5 §5.6 "Hooks"): the
 * Registry's cards (`useRegistryCards`, `useRegistryCard`), the gate packs (`useGatePacks`) and a brief
 * (`useGateBrief`), the assertions' vocabulary (`useAssertionVocabulary`), a flow's users (`useFlowUsage`), a flow at
 * a revision (`useFlowRevision`) and its expansion (`useExpandedFlow`). Reads are cached for five minutes; each asks
 * only where it can be answered: an administrator, a deployment with the engineering agents.
 *
 * @module components/WorkflowEditor/inspector/useFlowSetup
 */
import { useQuery } from '@tanstack/react-query'
import { flowSetupApi, flowSetupKeys } from '../../../api/flowSetupApi'
import { usedByOf, workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { retryOnceUnlessNotFound } from '../../../api/apiErrorStatus'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { useIsAdmin } from '../../../store/authStore'
import type { RegistryCard } from '../../../api/flowSetupApi'

/** Setup reads stay fresh this long (the Registry, the gates and the vocabulary change by a release or a person). */
export const SETUP_STALE_MS = 5 * 60_000

/** Whether this person, here, may read the setup routes (administrators, where the engineering agents are on). */
export function useCanReadSetup(): boolean {
  return useIsAdmin() && isEngineeringAvailable()
}

/** Every card of the Registry for a scope (null: the shared skills). */
export function useRegistryCards(connection: string | null, enabled = true) {
  const allowed = useCanReadSetup()
  return useQuery({
    queryKey: flowSetupKeys.registry(connection),
    queryFn: () => flowSetupApi.registry(connection),
    enabled: allowed && enabled,
    staleTime: SETUP_STALE_MS,
    retry: retryOnceUnlessNotFound,
  })
}

/** The Registry's cards by id (empty until read, or where they cannot be). */
export function cardsById(cards: readonly RegistryCard[] | undefined): ReadonlyMap<string, RegistryCard> {
  return new Map((cards ?? []).map((card) => [card.id, card]))
}

/** One card (a role's, or a made card at its current version) for a scope. */
export function useRegistryCard(card: string | undefined, connection: string | null) {
  const allowed = useCanReadSetup()
  return useQuery({
    queryKey: flowSetupKeys.card(card ?? '', connection),
    queryFn: () => flowSetupApi.card(card ?? '', connection),
    enabled: allowed && card !== undefined && card !== '',
    staleTime: SETUP_STALE_MS,
    retry: retryOnceUnlessNotFound,
  })
}

export function useGatePacks(connection: string | null, enabled = true) {
  const allowed = useCanReadSetup()
  return useQuery({
    queryKey: flowSetupKeys.gates(connection),
    queryFn: () => flowSetupApi.gates(connection),
    enabled: allowed && enabled,
    staleTime: SETUP_STALE_MS,
    retry: retryOnceUnlessNotFound,
  })
}

/** An owner's brief with its text, read when it is opened (45–156 KB each). */
export function useGateBrief(id: string, open: boolean) {
  const allowed = useCanReadSetup()
  return useQuery({
    queryKey: flowSetupKeys.brief(id),
    queryFn: () => flowSetupApi.brief(id),
    enabled: allowed && open && id !== '',
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
}

export function useAssertionVocabulary(enabled = true) {
  const allowed = useCanReadSetup()
  return useQuery({
    queryKey: flowSetupKeys.assertions(),
    queryFn: flowSetupApi.assertions,
    enabled: allowed && enabled,
    staleTime: SETUP_STALE_MS,
    retry: retryOnceUnlessNotFound,
  })
}

/** Who uses a stored flow (the automations that run it, the flows that call it), from its own read. */
export function useFlowUsage(workflowId: string | null) {
  const query = useQuery({
    queryKey: workflowsKeys.detail(workflowId ?? ''),
    queryFn: () => workflowsApi.get(workflowId ?? ''),
    enabled: workflowId !== null && workflowId !== '',
  })
  return { ...query, usedBy: usedByOf(query.data?.workflow) }
}

/** The library (the palette's flows, a call's child names). */
export function useFlowLibrary(enabled = true) {
  return useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, enabled })
}

/** A flow at one revision (a call's child, as the call pins it). */
export function useFlowRevision(workflowId: string | null, revision: number | null) {
  return useQuery({
    queryKey: workflowsKeys.revision(workflowId ?? '', revision ?? 0),
    queryFn: () => workflowsApi.getRevision(workflowId ?? '', revision ?? 0),
    enabled: workflowId !== null && revision !== null,
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
}

/** The flat flow a revision would run (its calls expanded), or the server's refusal (a 409's words). */
export function useExpandedFlow(workflowId: string | null, revision: number | null) {
  const allowed = useIsAdmin()
  return useQuery({
    queryKey: workflowsKeys.expanded(workflowId ?? '', revision),
    queryFn: () => workflowsApi.expanded(workflowId ?? '', revision ?? undefined),
    enabled: allowed && workflowId !== null,
    staleTime: SETUP_STALE_MS,
    retry: false,
  })
}
