#!/usr/bin/env node

/**
 * Tests for the dev mock's methodology mirror (mock-methodology.js): the same shapes and codes as
 * lambda/shared/methodology.py and lambda/shared/workflow_methodology.py, so the SPA renders the mock
 * like the API. It calls the helpers directly and starts no server.
 *
 * Run: node --test scripts/mock-methodology.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  documentRequestUse, generationMethodology, humanMethodology, projectMethodology, prototypeBlocked,
  workflowMethodologyWarnings,
} from '../mock-methodology.js'

const EMPTY = { personas: [], documents: [] }
const WITH_PRFAQ = {
  personas: [{ persona_id: 'p1' }],
  documents: [{ document_id: 'prfaq_1', document_type: 'prfaq' }, { document_id: 'r1', document_type: 'research' }],
}

describe('mock methodology: project overview', () => {
  it('lists every upstream step an empty project lacks, and blocks the prototype', () => {
    const { order, steps } = projectMethodology(EMPTY)
    assert.deepEqual(order, ['personas', 'research', 'prfaq', 'prd', 'prototype'])
    assert.deepEqual(steps.prd, { missing: ['personas', 'prfaq'], count: 0 })
    assert.equal(steps.prototype.blocked, true)
    assert.equal(prototypeBlocked(EMPTY), true)
  })

  it('clears a gap once its artifact exists', () => {
    const { steps } = projectMethodology(WITH_PRFAQ)
    assert.deepEqual([steps.prd.missing, steps.prfaq.count, steps.research.count], [[], 1, 1])
    assert.equal(prototypeBlocked(WITH_PRFAQ), false)
  })
})

describe('mock methodology: a generation block', () => {
  it('reports a missing and an unselected upstream step with the real messages', () => {
    const block = generationMethodology(WITH_PRFAQ, 'prd', documentRequestUse(WITH_PRFAQ, { data_sources: {} }))
    assert.deepEqual(block.skipped, [
      { step: 'personas', reason: 'not_selected' }, { step: 'prfaq', reason: 'not_selected' },
    ])
    assert.equal(block.warnings[0].message, 'This PRD is made without personas: it was not selected.')
    assert.equal(block.evidence, null)
  })

  it('reads feedback by default, and adds no_evidence when none reached the document', () => {
    assert.equal(documentRequestUse(EMPTY, {}).feedback, true)
    assert.equal(documentRequestUse(EMPTY, { data_sources: { feedback: false } }).feedback, false)
    const block = generationMethodology(EMPTY, 'prfaq', {}, { evidence: 0 })
    assert.deepEqual(block.warnings.map((w) => w.code), ['missing_upstream', 'no_evidence'])
  })

  it('counts a selected PR/FAQ as read only when documents are read', () => {
    const body = { data_sources: { documents: true }, selected_document_ids: ['prfaq_1'] }
    assert.equal(documentRequestUse(WITH_PRFAQ, body).prfaq, true)
    assert.equal(documentRequestUse(WITH_PRFAQ, { ...body, selected_document_ids: ['r1'] }).prfaq, false)
  })

  it('marks a hand-written document with evidence 0', () => {
    assert.deepEqual(humanMethodology('prd').evidence, 0)
    assert.deepEqual(humanMethodology('prd').warnings.map((w) => w.code), ['no_evidence'])
  })
})

describe('mock methodology: workflow warnings', () => {
  const node = (id, type) => ({ id, type })
  const edge = (source, target) => ({ source, target })

  it('warns a PRD with nothing before it, per missing kind', () => {
    const warnings = workflowMethodologyWarnings({
      nodes: [node('start', 'start'), node('prd', 'write_prd')], edges: [edge('start', 'prd')],
    })
    assert.deepEqual(warnings.map((w) => w.code), ['no_upstream_evidence', 'no_upstream_personas', 'no_upstream_prfaq'])
    assert.ok(warnings.every((w) => w.node_id === 'prd'))
  })

  it('is silent for the methodology path, through intermediate steps', () => {
    const warnings = workflowMethodologyWarnings({
      nodes: [node('a', 'aggregate_reviews'), node('p', 'generate_personas'), node('f', 'write_prfaq'),
        node('r', 'persona_review'), node('d', 'write_prd'), node('b', 'build_prototype')],
      edges: [edge('a', 'p'), edge('p', 'f'), edge('f', 'r'), edge('r', 'd'), edge('d', 'b')],
    })
    assert.deepEqual(warnings, [])
  })
})
