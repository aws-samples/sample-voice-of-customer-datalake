/**
 * @fileoverview Several agents at once: the tabs (open beside the active one, close and the next active, the live
 * ones with the active one kept), the grid's split tree of agent leaves (1, 2 or 4 panes, a pane filled,
 * closed with its split collapsing, a divider moved no further than MIN_FRAC, a resize keeping the agents), and the
 * layout kept per run in this tab's sessionStorage, per workspace; and the workspace's addresses.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT, MIN_FRAC, gridOf, leavesOf, liveTabs, loadLayout, nextActiveAfterClose, openTab, regrid,
  removeLeaf, replaceLeaf, resizeSplit, saveLayout, sizeOf,
} from './agentGridModel'
import { readRunAddress, runWorkspacePath } from './runWorkspacePaths'
import type { GridSplit } from './agentGridModel'

const agentsOf = (node: Parameters<typeof leavesOf>[0]) => leavesOf(node).map((pane) => pane.agent)

describe('the tabs', () => {
  it('opens a session right after the active one, and leaves one already open where it is', () => {
    expect(openTab(['o', 'a', 'b'], 'c', 'a')).toStrictEqual(['o', 'a', 'c', 'b'])
    expect(openTab(['o', 'a'], 'c', null)).toStrictEqual(['o', 'a', 'c'])
    expect(openTab(['o', 'a'], 'a', 'o')).toStrictEqual(['o', 'a'])
  })

  it('shows the neighbour once the active tab is closed, and keeps another active one', () => {
    expect([nextActiveAfterClose(['o', 'a', 'b'], 'b', 'b'), nextActiveAfterClose(['o', 'a', 'b'], 'o', 'o'), nextActiveAfterClose(['o', 'a'], 'o', 'a')])
      .toStrictEqual(['a', 'a', 'a'])
    expect(nextActiveAfterClose(['o'], 'o', 'o')).toBeNull()
  })

  it('drops the tabs of agents no longer in the run and keeps the active session a tab', () => {
    expect(liveTabs(['o', 'gone', 'a'], new Set(['o', 'a', 'b']), 'b')).toStrictEqual(['o', 'a', 'b'])
  })
})

describe('the grid', () => {
  it('lays out 1, 2 or 4 panes, filled in order and empty past the agents', () => {
    expect([agentsOf(gridOf(1, ['a'])), agentsOf(gridOf(2, ['a'])), agentsOf(gridOf(4, ['a', 'b', 'c']))])
      .toStrictEqual([['a'], ['a', null], ['a', 'b', 'c', null]])
    expect([sizeOf(gridOf(4, [])), sizeOf(gridOf(2, [])), sizeOf(null)]).toStrictEqual([4, 2, 1])
  })

  it('fills one pane with an agent, leaving the tree it came from unchanged', () => {
    const grid = gridOf(2, ['a'])
    expect(agentsOf(replaceLeaf(grid, 'p1', (pane) => ({ ...pane, agent: 'b' })))).toStrictEqual(['a', 'b'])
    expect(agentsOf(grid)).toStrictEqual(['a', null])
  })

  it('closes a pane: its split of one collapses, the siblings\' sizes renormalise, the last one empties the grid', () => {
    const three = removeLeaf(gridOf(4, ['a', 'b', 'c', 'd']), 'p0')
    expect(three).toMatchObject({ type: 'split', children: [{ type: 'leaf', agent: 'b' }, { type: 'split', id: 's2' }] })
    const wide: GridSplit = { type: 'split', id: 's9', dir: 'col', sizes: [0.5, 0.25, 0.25], children: [
      { type: 'leaf', id: 'x', agent: 'a' }, { type: 'leaf', id: 'y', agent: 'b' }, { type: 'leaf', id: 'z', agent: 'c' }] }
    expect(removeLeaf(wide, 'x')).toMatchObject({ sizes: [0.5, 0.5] })
    expect(removeLeaf(gridOf(1, ['a']), 'p0')).toBeNull()
  })

  it('moves a divider, never shrinking a pane below MIN_FRAC', () => {
    const two = gridOf(2, ['a', 'b'])
    expect(resizeSplit(two, 's0', 0, 0.9)).toMatchObject({ sizes: [expect.closeTo(1 - MIN_FRAC), expect.closeTo(MIN_FRAC)] })
    expect(resizeSplit(two, 's0', 0, -0.1)).toMatchObject({ sizes: [expect.closeTo(0.4), expect.closeTo(0.6)] })
  })

  it('regrids to another size with the agents kept, the active one first, the open tabs filling the rest', () => {
    const layout = { ...DEFAULT_LAYOUT, mode: 'grid' as const, tabs: ['o', 'a', 'b'], grid: gridOf(2, ['a', 'c']) }
    expect(agentsOf(regrid(layout, 4, 'o'))).toStrictEqual(['o', 'a', 'c', 'b'])
    expect(agentsOf(regrid(layout, 1, 'c'))).toStrictEqual(['c'])
  })
})

describe('the layout kept in this tab', () => {
  afterEach(() => { window.sessionStorage.clear() })

  it('keeps a run\'s layout in sessionStorage and reads it back; another run starts from the tabs', () => {
    const layout = { mode: 'grid' as const, tabs: ['o', 'a'], grid: gridOf(2, ['o', 'a']) }
    saveLayout('RUN1', layout)
    expect([loadLayout('RUN1'), loadLayout('RUN2')]).toStrictEqual([layout, DEFAULT_LAYOUT])
    expect(Object.keys(window.sessionStorage)).toStrictEqual(['voc-run-workspace'])
  })

  it('reads a record that is not one as the default', () => {
    window.sessionStorage.setItem('voc-run-workspace', '{"not": "a list"}')
    expect(loadLayout('RUN1')).toStrictEqual(DEFAULT_LAYOUT)
  })

  it('reads a split that is not one (a single child) as no layout', () => {
    const broken: GridSplit = { type: 'split', id: 's0', dir: 'col', children: [{ type: 'leaf', id: 'p0', agent: 'a' }], sizes: [1] }
    window.sessionStorage.setItem('voc-run-workspace', JSON.stringify([['RUN1', { mode: 'grid', tabs: [], grid: broken }]]))
    expect(loadLayout('RUN1')).toStrictEqual(DEFAULT_LAYOUT)
  })
})

describe('the workspace\'s addresses', () => {
  it('writes a run, and one of its agents open in it, as paths', () => {
    expect([runWorkspacePath('RUN1'), runWorkspacePath('RUN1', 'fixer-3'), runWorkspacePath('R 1', 'a/b')])
      .toStrictEqual(['/agents/engineering/RUN1', '/agents/engineering/RUN1/a/fixer-3', '/agents/engineering/R%201/a/a%2Fb'])
  })

  it('reads them back, and replaces a path off its form by the run\'s own, the query kept', () => {
    const read = (pathname: string) => readRunAddress({ pathname, search: '?x=1' })
    expect([read('/agents/engineering/RUN1')?.place, read('/agents/engineering/RUN1/a/fixer-3')?.place])
      .toStrictEqual([{ agent: null }, { agent: 'fixer-3' }])
    expect(read('/agents/engineering/RUN1/b/fixer-3')?.replaceWith).toStrictEqual({ pathname: '/agents/engineering/RUN1', search: '?x=1' })
    expect([read('/agents/engineering'), read('/agents/runs')]).toStrictEqual([null, null])
  })
})
