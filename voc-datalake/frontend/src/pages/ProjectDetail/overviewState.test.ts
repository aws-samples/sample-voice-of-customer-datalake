/**
 * @fileoverview Tests for the Overview cards' derived state (U8).
 *
 * The defect these pin is that the Overview tab read identically on an empty
 * project and a finished one. Asserting the derivation directly is what makes
 * "the cards differ" a statement about data rather than about markup.
 */
import { describe, it, expect } from 'vitest'
import { deriveOverviewState } from './overviewState'
import { emptyProductContext, PRODUCT_CONTEXT_FIELD_COUNT } from './productContextFields'
import type { ProductContext, ProjectDocument, ProjectPersona } from '../../api/types'

const persona = (id: string): ProjectPersona => ({
  persona_id: id,
  name: `Persona ${id}`,
  tagline: '',
  created_at: '',
})

const doc = (id: string, type: ProjectDocument['document_type']): ProjectDocument => ({
  document_id: id,
  document_type: type,
  title: `Doc ${id}`,
  content: '',
  created_at: '',
})

const filledContext = (fields: Partial<ProductContext>): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

describe('deriveOverviewState', () => {
  describe('card order', () => {
    it('numbers the steps in dependency order: product, personas, research, documents, remix', () => {
      // Personas before research is the correction this work exists for: research
      // can read personas, personas cannot read research.
      const { steps } = deriveOverviewState({ personas: [], documents: [] })

      expect(steps.product.position).toBe(1)
      expect(steps.personas.position).toBe(2)
      expect(steps.research.position).toBe(3)
      expect(steps.documents.position).toBe(4)
      expect(steps.remix.position).toBe(5)
    })
  })

  describe('output state', () => {
    it('reports nothing done on an empty project', () => {
      const { steps } = deriveOverviewState({
        personas: [],
        documents: [],
        productContext: emptyProductContext(),
      })

      expect(steps.product.hasOutput).toBe(false)
      expect(steps.personas.hasOutput).toBe(false)
      expect(steps.research.hasOutput).toBe(false)
      expect(steps.documents.hasOutput).toBe(false)
    })

    it('counts personas', () => {
      const { steps } = deriveOverviewState({
        personas: [persona('p1'), persona('p2'), persona('p3')],
        documents: [],
      })

      expect(steps.personas.hasOutput).toBe(true)
      expect(steps.personas.count).toBe(3)
    })

    it('counts research documents separately from generated documents', () => {
      const { steps } = deriveOverviewState({
        personas: [],
        documents: [doc('d1', 'research'), doc('d2', 'prd'), doc('d3', 'prfaq')],
      })

      expect(steps.research.count).toBe(1)
      expect(steps.documents.count).toBe(2)
    })

    it('ignores document types that are not research, PRD or PR-FAQ', () => {
      // A prototype or a product report is an artifact of a different step, so it
      // must not make the PRD/PR-FAQ card claim output it does not have.
      const { steps } = deriveOverviewState({
        personas: [],
        documents: [doc('d1', 'prototype'), doc('d2', 'product_report'), doc('d3', 'custom')],
      })

      expect(steps.documents.hasOutput).toBe(false)
      expect(steps.documents.count).toBe(0)
      expect(steps.research.hasOutput).toBe(false)
    })

    it('counts filled product-context fields against the real field total', () => {
      const { steps } = deriveOverviewState({
        personas: [],
        documents: [],
        productContext: filledContext({
          product_name: 'VoC',
          one_liner: 'Feedback intelligence',
        }),
      })

      expect(steps.product.hasOutput).toBe(true)
      expect(steps.product.filled).toBe(2)
      expect(steps.product.total).toBe(PRODUCT_CONTEXT_FIELD_COUNT)
    })

    it('treats whitespace-only product fields as empty', () => {
      const { steps } = deriveOverviewState({
        personas: [],
        documents: [],
        productContext: filledContext({ product_name: '   ' }),
      })

      expect(steps.product.filled).toBe(0)
      expect(steps.product.hasOutput).toBe(false)
    })

    it('leaves the product card stateless while the context is unknown', () => {
      // Undefined is not "empty": the request may still be in flight or have
      // failed, and a card that cannot know must not claim the description is
      // blank.
      const { steps } = deriveOverviewState({ personas: [], documents: [] })

      expect(steps.product.filled).toBeUndefined()
      expect(steps.product.hasOutput).toBe(false)
    })
  })

  describe('missing upstream inputs', () => {
    it('flags research when there are no personas to ground it', () => {
      const { steps } = deriveOverviewState({ personas: [], documents: [] })
      expect(steps.research.missingUpstream).toBe(true)
    })

    it('clears the research flag once personas exist', () => {
      const { steps } = deriveOverviewState({ personas: [persona('p1')], documents: [] })
      expect(steps.research.missingUpstream).toBe(false)
    })

    it('flags documents only when neither personas nor research exist', () => {
      const noContext = deriveOverviewState({ personas: [], documents: [] })
      expect(noContext.steps.documents.missingUpstream).toBe(true)

      const withResearch = deriveOverviewState({
        personas: [],
        documents: [doc('d1', 'research')],
      })
      expect(withResearch.steps.documents.missingUpstream).toBe(false)

      const withPersonas = deriveOverviewState({ personas: [persona('p1')], documents: [] })
      expect(withPersonas.steps.documents.missingUpstream).toBe(false)
    })

    it('flags remix below two documents', () => {
      const one = deriveOverviewState({ personas: [], documents: [doc('d1', 'prd')] })
      expect(one.steps.remix.missingUpstream).toBe(true)

      const two = deriveOverviewState({
        personas: [],
        documents: [doc('d1', 'prd'), doc('d2', 'prfaq')],
      })
      expect(two.steps.remix.missingUpstream).toBe(false)
    })
  })

  describe('next step', () => {
    it('recommends describing the product on an untouched project', () => {
      const state = deriveOverviewState({
        personas: [],
        documents: [],
        productContext: emptyProductContext(),
      })
      expect(state.nextStep).toBe('product')
    })

    it('skips the product step while the context is unknown', () => {
      // Telling someone to describe a product they already described is worse than
      // saying nothing, and the answer arrives a render later.
      const state = deriveOverviewState({ personas: [], documents: [] })
      expect(state.nextStep).toBe('personas')
    })

    it('recommends research once personas exist and none has been run', () => {
      const state = deriveOverviewState({
        personas: [persona('p1')],
        documents: [],
        productContext: filledContext({ product_name: 'VoC' }),
      })
      expect(state.nextStep).toBe('research')
    })

    it('recommends documents once research exists', () => {
      const state = deriveOverviewState({
        personas: [persona('p1')],
        documents: [doc('d1', 'research')],
        productContext: filledContext({ product_name: 'VoC' }),
      })
      expect(state.nextStep).toBe('documents')
    })

    it('recommends nothing once every step has produced something', () => {
      // Remix is deliberately never recommended: it revises rather than advances,
      // and it is the one step with a hard requirement.
      const state = deriveOverviewState({
        personas: [persona('p1')],
        documents: [doc('d1', 'research'), doc('d2', 'prd')],
        productContext: filledContext({ product_name: 'VoC' }),
      })
      expect(state.nextStep).toBeNull()
    })

    it('recommends the earliest gap rather than the latest', () => {
      // A project with documents but no personas should still be sent back to
      // personas — otherwise the ordering advice only applies to new projects.
      const state = deriveOverviewState({
        personas: [],
        documents: [doc('d1', 'prd')],
        productContext: filledContext({ product_name: 'VoC' }),
      })
      expect(state.nextStep).toBe('personas')
    })
  })
})
