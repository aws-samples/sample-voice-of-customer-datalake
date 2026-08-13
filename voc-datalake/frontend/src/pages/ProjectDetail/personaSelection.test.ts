/**
 * @fileoverview Tests for project-chat persona resolution.
 *
 * The case that matters: `@all` is a shorthand over a list the user does not
 * control, and persona import appends without replacing, so it can name more
 * personas than the stream request may carry. Unclamped, that came back as an
 * opaque 400.
 *
 * @module pages/ProjectDetail/personaSelection.test
 */
import { describe, expect, it } from 'vitest'
import { MAX_SELECTED_PERSONAS } from '../../api/streamLimits'
import { resolvePersonaSelection } from './personaSelection'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `persona-${i}`)

describe('resolvePersonaSelection', () => {
  it('addresses nobody in particular for a plain message', () => {
    expect(resolvePersonaSelection('what do you think?', ids(3), [], false)).toStrictEqual({
      isRoundtable: false, selectedPersonaIds: [],
    })
  })

  it('expands @all to every persona when the project is small', () => {
    const result = resolvePersonaSelection('@all what do you think?', ids(3), [], false)
    expect(result.isRoundtable).toBe(true)
    expect(result.selectedPersonaIds).toStrictEqual(['persona-0', 'persona-1', 'persona-2'])
    expect(result.clampedFrom).toBeUndefined()
  })

  it('clamps @all to the request cap on a project with more personas', () => {
    const total = MAX_SELECTED_PERSONAS + 7
    const result = resolvePersonaSelection('@all thoughts?', ids(total), [], false)
    expect(result.selectedPersonaIds).toHaveLength(MAX_SELECTED_PERSONAS)
    expect(result.clampedFrom).toBe(total)
    // Keeps the first N rather than an arbitrary subset.
    expect(result.selectedPersonaIds[0]).toBe('persona-0')
    expect(result.selectedPersonaIds.at(-1)).toBe(`persona-${MAX_SELECTED_PERSONAS - 1}`)
  })

  it('reports no clamp when the project sits exactly on the cap', () => {
    const result = resolvePersonaSelection('@all', ids(MAX_SELECTED_PERSONAS), [], false)
    expect(result.selectedPersonaIds).toHaveLength(MAX_SELECTED_PERSONAS)
    expect(result.clampedFrom).toBeUndefined()
  })

  it('does not treat @all as roundtable with a single persona', () => {
    const result = resolvePersonaSelection('@all hello', ids(1), [], false)
    expect(result.isRoundtable).toBe(false)
    expect(result.selectedPersonaIds).toStrictEqual([])
  })

  it('honours an explicit selection over @all expansion', () => {
    const result = resolvePersonaSelection('@all hello', ids(30), ['persona-4'], false)
    expect(result.selectedPersonaIds).toStrictEqual(['persona-4'])
    expect(result.clampedFrom).toBeUndefined()
  })

  it('expands when roundtable is set by mention state rather than by text', () => {
    const result = resolvePersonaSelection('thoughts?', ids(3), [], true)
    expect(result.isRoundtable).toBe(true)
    expect(result.selectedPersonaIds).toHaveLength(3)
  })

  it('matches @all case-insensitively and as a whole word only', () => {
    expect(resolvePersonaSelection('@ALL hi', ids(3), [], false).isRoundtable).toBe(true)
    expect(resolvePersonaSelection('hi @all', ids(3), [], false).isRoundtable).toBe(true)
    expect(resolvePersonaSelection('@allison hi', ids(3), [], false).isRoundtable).toBe(false)
  })

  it('does not return the caller its own array to mutate', () => {
    const personaIds = ids(3)
    const result = resolvePersonaSelection('@all', personaIds, [], false)
    expect(result.selectedPersonaIds).not.toBe(personaIds)
  })
})
