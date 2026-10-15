/**
 * @fileoverview Tests for useProjectWizardState — U8's payoff for doing personas
 * before research.
 *
 * Research is the one generator that can read personas, but the wizard defaults
 * `usePersonas` to false, so persona-grounded research was available only to
 * someone who knew to go looking for it. Opening the wizard with the project's
 * personas already selected makes the grounded run the default.
 */
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useProjectWizardState } from './useProjectWizardState'

describe('useProjectWizardState', () => {
  describe('openResearchWizard', () => {
    it('opens the research wizard with the project personas selected', () => {
      const { result } = renderHook(() => useProjectWizardState())

      act(() => result.current.openResearchWizard(['p1', 'p2']))

      expect(result.current.activeWizard).toBe('research')
      expect(result.current.contextConfig.usePersonas).toBe(true)
      expect(result.current.contextConfig.selectedPersonaIds).toEqual(['p1', 'p2'])
    })

    it('keeps feedback on, since research reads it too', () => {
      const { result } = renderHook(() => useProjectWizardState())

      act(() => result.current.openResearchWizard(['p1']))

      expect(result.current.contextConfig.useFeedback).toBe(true)
    })

    it('leaves personas off when the project has none', () => {
      // Enabling an empty selection would show a "Personas" source with nothing to
      // pick, and the wizard's own gating hides the card anyway.
      const { result } = renderHook(() => useProjectWizardState())

      act(() => result.current.openResearchWizard([]))

      expect(result.current.activeWizard).toBe('research')
      expect(result.current.contextConfig.usePersonas).toBe(false)
      expect(result.current.contextConfig.selectedPersonaIds).toEqual([])
    })

    it('does not carry a previous wizard configuration over', () => {
      // openMergeWizard turns feedback off and documents on. Reopening research
      // must start from the defaults rather than inherit that.
      const { result } = renderHook(() => useProjectWizardState())

      act(() => result.current.openMergeWizard())
      act(() => result.current.openResearchWizard(['p1']))

      expect(result.current.contextConfig.useFeedback).toBe(true)
      expect(result.current.contextConfig.useDocuments).toBe(false)
      expect(result.current.contextConfig.useResearch).toBe(false)
    })

    it('resets back to the defaults when the wizard closes', () => {
      const { result } = renderHook(() => useProjectWizardState())

      act(() => result.current.openResearchWizard(['p1']))
      act(() => result.current.resetWizard())

      expect(result.current.activeWizard).toBeNull()
      expect(result.current.contextConfig.usePersonas).toBe(false)
      expect(result.current.contextConfig.selectedPersonaIds).toEqual([])
    })

    it('copies the ids rather than holding the array the caller passed', () => {
      const { result } = renderHook(() => useProjectWizardState())
      const ids = ['p1']

      act(() => result.current.openResearchWizard(ids))
      ids.push('p2')

      expect(result.current.contextConfig.selectedPersonaIds).toEqual(['p1'])
    })
  })
})
