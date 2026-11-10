/**
 * @fileoverview The canvas stays legible (live test: an 18-step workflow fitted
 * into the 640 px editor rendered step text at ~5 px): the fit is floored at a
 * readable zoom, and a graph too large for the panel is centred on one step —
 * the run graph's active step, the editor's start.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { emptyDefinition } from './model-fixtures'
import { STEP_HEIGHT, STEP_WIDTH } from './model'
import type { StepState } from './runState'

const flow = vi.hoisted(() => ({
  zoom: 0.6,
  initialized: true,
  fitView: vi.fn((_options: unknown) => Promise.resolve(true)),
  setCenter: vi.fn((_x: number, _y: number, _options: unknown) => Promise.resolve(true)),
}))

vi.mock('@xyflow/react', () => ({
  useNodesInitialized: () => flow.initialized,
  useReactFlow: () => ({ fitView: flow.fitView, setCenter: flow.setCenter, getZoom: () => flow.zoom }),
}))

const { FIT_VIEW_OPTIONS, fitHitFloor, focusStepId, startStepId, useFocusStep } = await import('./canvasFocus')

const state = (status: StepState['status']): StepState => ({ status, rounds: 1 })

beforeEach(() => {
  flow.zoom = 0.6
  flow.initialized = true
  flow.fitView.mockClear()
  flow.setCenter.mockClear()
})

describe('FIT_VIEW_OPTIONS', () => {
  it('floors the fit at a readable zoom and never magnifies past 1:1', () => {
    expect(FIT_VIEW_OPTIONS.minZoom).toBeGreaterThanOrEqual(0.6)
    expect(FIT_VIEW_OPTIONS.maxZoom).toBe(1)
  })

  it('treats a fit on the floor as "the graph does not fit"', () => {
    expect(fitHitFloor(FIT_VIEW_OPTIONS.minZoom)).toBe(true)
    expect(fitHitFloor(0.9)).toBe(false)
  })
})

describe('focusStepId', () => {
  it('prefers the running step, then a failed one, then the last finished', () => {
    expect(focusStepId(new Map([['a', state('done')], ['b', state('running')]]))).toBe('b')
    expect(focusStepId(new Map([['a', state('done')], ['b', state('failed')]]))).toBe('b')
    expect(focusStepId(new Map([['a', state('done')], ['b', state('done')], ['c', state('idle')]]))).toBe('b')
    expect(focusStepId(new Map())).toBeUndefined()
  })

  it('finds the start step of a definition', () => {
    expect(startStepId(emptyDefinition('Flow'))).toBe('start')
  })
})

describe('useFocusStep', () => {
  const definition = emptyDefinition('Flow')

  it('centres on the focused step when the graph does not fit', async () => {
    renderHook(() => useFocusStep(definition, 'end'))
    await waitFor(() => expect(flow.setCenter).toHaveBeenCalledWith(STEP_WIDTH / 2, 280 + STEP_HEIGHT / 2, { zoom: 0.6 }))
    expect(flow.fitView).toHaveBeenCalledWith(FIT_VIEW_OPTIONS)
  })

  it('leaves a graph that fits as fitted', async () => {
    flow.zoom = 0.95
    renderHook(() => useFocusStep(definition, 'end'))
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledWith(FIT_VIEW_OPTIONS))
    expect(flow.setCenter).not.toHaveBeenCalled()
  })

  it('waits for React Flow to measure the steps', () => {
    flow.initialized = false
    renderHook(() => useFocusStep(definition, 'end'))
    expect(flow.fitView).not.toHaveBeenCalled()
  })
})
