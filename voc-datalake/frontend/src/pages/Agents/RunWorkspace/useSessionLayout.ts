/**
 * @fileoverview The sessions open in a run's workspace (7.51.00): the tabs or the grid (agentGridModel.ts), kept in this
 * tab's sessionStorage, and the session shown, which is the ADDRESS's (`…/a/<agent>`, the orchestrator's without one:
 * runWorkspacePaths.ts), so Back walks the sessions opened. Everything that opens a session (a tab, the canvas, the
 * timeline, a grid pane) goes through `open`, which keeps it a tab (and in the grid, a pane) and moves to it.
 *
 * @module pages/Agents/RunWorkspace/useSessionLayout
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlaceNavigate } from '../../../utils/pathPlace'
import {
  DEFAULT_LAYOUT, leavesOf, liveTabs, loadLayout, nextActiveAfterClose, openTab, regrid, removeLeaf, replaceLeaf,
  resizeSplit, saveLayout,
} from './agentGridModel'
import { runWorkspacePath } from './runWorkspacePaths'
import type { GridNode, GridSize, SessionLayout } from './agentGridModel'

/** The grid with `agent` shown: as it is when a pane holds it, else in the first empty pane, else in the last. */
function withPane(grid: GridNode | null, agent: string): GridNode | null {
  const panes = leavesOf(grid)
  if (grid === null || panes.some((pane) => pane.agent === agent)) return grid
  const target = panes.find((pane) => pane.agent === null) ?? panes.at(-1)
  return target === undefined ? grid : replaceLeaf(grid, target.id, (pane) => ({ ...pane, agent }))
}

/** A session's name: the orchestrator's, or the agent's id. */
export function useSessionName(orchestrator: string | null): (agent: string) => string {
  const { t } = useTranslation('agents')
  return (agent) => (agent === orchestrator ? t('runWorkspace.orchestrator') : agent)
}

export function useSessionLayout(runId: string, current: string | null, orchestrator: string | null, live: ReadonlySet<string>) {
  const move = usePlaceNavigate()
  const [kept, setKept] = useState<{ runId: string; layout: SessionLayout }>(() => ({ runId, layout: loadLayout(runId) }))
  // Another run opened in place: its own layout.
  const layout = kept.runId === runId ? kept.layout : loadLayout(runId)
  useEffect(() => { saveLayout(kept.runId, kept.layout) }, [kept])
  const update = (change: (before: SessionLayout) => SessionLayout) => {
    setKept((before) => ({ runId, layout: change(before.runId === runId ? before.layout : DEFAULT_LAYOUT) }))
  }
  const go = (agent: string | null) => {
    move({ pathname: runWorkspacePath(runId, agent === orchestrator ? null : agent), search: '' })
  }
  const tabs = liveTabs(layout.tabs, live, current)
  const open = (agent: string) => {
    update((before) => ({
      ...before, tabs: openTab(liveTabs(before.tabs, live, current), agent, current), grid: withPane(before.grid, agent),
    }))
    go(agent)
  }
  const close = (agent: string) => {
    update((before) => ({ ...before, tabs: tabs.filter((tab) => tab !== agent) }))
    if (agent === current) go(nextActiveAfterClose(tabs, agent, current) ?? orchestrator)
  }
  return {
    mode: layout.mode, tabs, grid: layout.grid, open, close,
    showTabs: () => { update((before) => ({ ...before, mode: 'tabs' })) },
    showGrid: (size: GridSize) => { update((before) => ({ ...before, mode: 'grid', grid: regrid({ ...before, tabs }, size, current) })) },
    fillPane: (paneId: string, agent: string | null) => {
      update((before) => ({ ...before, grid: before.grid === null ? null : replaceLeaf(before.grid, paneId, (pane) => ({ ...pane, agent })) }))
    },
    closePane: (paneId: string) => {
      update((before) => {
        const grid = before.grid === null ? null : removeLeaf(before.grid, paneId)
        return { ...before, grid, mode: grid === null ? 'tabs' : before.mode }
      })
    },
    resize: (splitId: string, index: number, delta: number) => {
      update((before) => ({ ...before, grid: before.grid === null ? null : resizeSplit(before.grid, splitId, index, delta) }))
    },
  }
}
