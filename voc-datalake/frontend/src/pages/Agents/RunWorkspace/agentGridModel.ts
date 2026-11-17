/**
 * @fileoverview Several agents open at once (7.51.00): the tabs (the default) or a grid of 1, 2 or 4 sessions, as
 * pure operations on the layout, and the layout kept per run in this tab's sessionStorage (through
 * workspace/workspaceStorage.ts, so each workspace keeps its own and sign-out forgets them).
 *
 * Adapted from kirodotdev/KiroCrew `website/src/hooks/useSessionTabs.ts` with `website/src/lib/sessionTabs.ts` (open
 * beside the active tab, close and the next active, prune against the live sessions, the active session always a
 * tab) and `website/src/hooks/useSessionGrid.ts` (the immutable split tree: `replaceLeaf`, `removeLeaf` collapsing
 * a split of one and renormalising its sizes, a resize clamped at `MIN_FRAC`), Apache-2.0
 * (THIRD-PARTY-LICENSES.md). Limited to agent leaves: a pane holds an agent of the run, or nothing yet.
 *
 * @module pages/Agents/RunWorkspace/agentGridModel
 */
import { z } from 'zod'
import { workspaceStorageName } from '../../../workspace/workspaceStorage'

/** A pane can't be shrunk below this share of its split. */
export const MIN_FRAC = 0.12
export const GRID_SIZES = [1, 2, 4] as const
export type GridSize = (typeof GRID_SIZES)[number]

export interface GridLeaf { readonly type: 'leaf'; readonly id: string; readonly agent: string | null }
/** `col`: children left to right; `row`: top to bottom. */
export interface GridSplit {
  readonly type: 'split'; readonly id: string; readonly dir: 'row' | 'col'
  readonly children: readonly GridNode[]; readonly sizes: readonly number[]
}
export type GridNode = GridLeaf | GridSplit

export interface SessionLayout {
  readonly mode: 'tabs' | 'grid'
  readonly tabs: readonly string[]
  readonly grid: GridNode | null
}

export const DEFAULT_LAYOUT: SessionLayout = { mode: 'tabs', tabs: [], grid: null }

// ── the tabs ───────────────────────────────────────────────────────────────

/** `tabs` with `key` opened right after `after` (at the end when `after` is not a tab); unchanged when it is one. */
export function openTab(tabs: readonly string[], key: string, after: string | null): string[] {
  if (tabs.includes(key)) return [...tabs]
  const next = [...tabs]
  const at = after === null ? -1 : next.indexOf(after)
  if (at === -1) next.push(key)
  else next.splice(at + 1, 0, key)
  return next
}

/** The session to show once `key` is closed: the active one, or its neighbour when it was the one closed. */
export function nextActiveAfterClose(tabs: readonly string[], key: string, active: string | null): string | null {
  if (active !== key) return active
  const at = tabs.indexOf(key)
  const rest = tabs.filter((tab) => tab !== key)
  if (at === -1 || rest.length === 0) return null
  return rest[Math.min(at, rest.length - 1)] ?? null
}

/** The tabs that are still sessions of the run, with the active one always among them. */
export function liveTabs(tabs: readonly string[], live: ReadonlySet<string>, active: string | null): string[] {
  const kept = tabs.filter((tab) => live.has(tab))
  return active === null || kept.includes(active) ? kept : [...kept, active]
}

// ── the grid: an immutable split tree of agent leaves ─────────────────────

const leaf = (index: number, agent: string | null): GridLeaf => ({ type: 'leaf', id: `p${String(index)}`, agent })

/** A grid of `size` panes, filled in order from `agents` (empty panes past them). */
export function gridOf(size: GridSize, agents: readonly (string | null)[]): GridNode {
  const panes = Array.from({ length: size }, (_, index) => leaf(index, agents[index] ?? null))
  const [first, second, third, fourth] = panes
  if (first === undefined) return leaf(0, null)
  if (second === undefined) return first
  const pair = (id: string, a: GridLeaf, b: GridLeaf): GridSplit =>
    ({ type: 'split', id, dir: 'col', children: [a, b], sizes: [0.5, 0.5] })
  if (third === undefined || fourth === undefined) return pair('s0', first, second)
  return { type: 'split', id: 's0', dir: 'row', children: [pair('s1', first, second), pair('s2', third, fourth)], sizes: [0.5, 0.5] }
}

/** Replace the leaf with id `targetId` by the node `make(leaf)` returns. */
export function replaceLeaf(node: GridNode, targetId: string, make: (found: GridLeaf) => GridNode): GridNode {
  if (node.type === 'leaf') return node.id === targetId ? make(node) : node
  return { ...node, children: node.children.map((child) => replaceLeaf(child, targetId, make)) }
}

/** Remove leaf `id`; a split left with one child becomes that child; the siblings' sizes renormalise. Null: emptied. */
export function removeLeaf(node: GridNode, id: string): GridNode | null {
  if (node.type === 'leaf') return node.id === id ? null : node
  const kept = node.children.flatMap((child, index) => {
    const rest = removeLeaf(child, id)
    return rest === null ? [] : [{ child: rest, size: node.sizes[index] ?? 1 / node.children.length }]
  })
  const [only] = kept
  if (only === undefined) return null
  if (kept.length === 1) return only.child
  const sum = kept.reduce((total, { size }) => total + size, 0) || 1
  return { ...node, children: kept.map(({ child }) => child), sizes: kept.map(({ size }) => size / sum) }
}

/** Shift `delta` of split `splitId`'s extent from child `index + 1` to child `index`, neither below {@link MIN_FRAC}. */
export function resizeSplit(node: GridNode, splitId: string, index: number, delta: number): GridNode {
  if (node.type === 'leaf') return node
  if (node.id !== splitId) return { ...node, children: node.children.map((child) => resizeSplit(child, splitId, index, delta)) }
  const sizes = [...node.sizes]
  const here = sizes[index] ?? 0
  const there = sizes[index + 1] ?? 0
  const moved = Math.max(Math.min(delta, there - MIN_FRAC), -(here - MIN_FRAC))
  sizes[index] = here + moved
  sizes[index + 1] = there - moved
  return { ...node, sizes }
}

/** Every leaf, depth first (the panes in reading order). */
export function leavesOf(node: GridNode | null): GridLeaf[] {
  if (node === null) return []
  return node.type === 'leaf' ? [node] : node.children.flatMap(leavesOf)
}

/** The grid's size: its leaves, read as the nearest size offered. */
export function sizeOf(node: GridNode | null): GridSize {
  const count = leavesOf(node).length
  return GRID_SIZES.find((size) => size >= count) ?? 4
}

/** The grid resized to `size`, its agents kept in order and the open tabs filling the new panes. */
export function regrid(layout: SessionLayout, size: GridSize, active: string | null): GridNode {
  const agents = [active, ...leavesOf(layout.grid).map((pane) => pane.agent), ...layout.tabs]
  const unique = [...new Set(agents.filter((agent): agent is string => agent !== null))]
  return gridOf(size, unique)
}

// ── kept per run in this tab ───────────────────────────────────────────────

const STORE = 'voc-run-workspace'
/** The runs whose layout is kept: the latest opened. */
const KEPT_RUNS = 20

const LeafSchema = z.object({ type: z.literal('leaf'), id: z.string(), agent: z.string().nullable() })
const NodeSchema: z.ZodType<GridNode> = z.lazy(() => z.union([LeafSchema, z.object({
  type: z.literal('split'), id: z.string(), dir: z.enum(['row', 'col']),
  children: z.array(NodeSchema).min(2).max(4), sizes: z.array(z.number().positive()).min(2).max(4),
})]))
const LayoutSchema = z.object({
  mode: z.enum(['tabs', 'grid']), tabs: z.array(z.string()).max(50), grid: NodeSchema.nullable(),
})
const RecordSchema = z.array(z.tuple([z.string(), LayoutSchema])).max(KEPT_RUNS).catch([])

function readRecord(): [string, SessionLayout][] {
  try {
    const raw = window.sessionStorage.getItem(workspaceStorageName(STORE))
    return raw === null ? [] : RecordSchema.parse(JSON.parse(raw))
  } catch {
    // Storage blocked (a privacy mode) or a record that is not one: the defaults.
    return []
  }
}

/** The layout kept for `runId` in this tab, or the default (tabs). */
export function loadLayout(runId: string): SessionLayout {
  return readRecord().find(([id]) => id === runId)?.[1] ?? DEFAULT_LAYOUT
}

/** Keep `layout` for `runId` in this tab (the latest {@link KEPT_RUNS} runs). */
export function saveLayout(runId: string, layout: SessionLayout): void {
  const record = [[runId, layout] as const, ...readRecord().filter(([id]) => id !== runId)].slice(0, KEPT_RUNS)
  try {
    window.sessionStorage.setItem(workspaceStorageName(STORE), JSON.stringify(record))
  } catch {
    // Storage blocked or full: the layout lasts as long as the page.
  }
}
