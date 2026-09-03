import { describe, expect, it, vi } from 'vitest'
import { normalizeProjectDetail } from './projectDetailSchema'

function envelope(personas: unknown[] = [], documents: unknown[] = []) {
  return { project: { project_id: 'project-1' }, personas, documents }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a record')
  }
  return Object.fromEntries(Object.entries(value))
}

describe('normalizeProjectDetail', () => {
  it('keeps sparse legacy rows readable with safe required defaults', () => {
    const result = normalizeProjectDetail(envelope(
      [{ persona_id: 'persona-1' }],
      [{ document_id: 'document-1', document_type: 'custom' }],
    ))

    expect(result.project).toMatchObject({
      project_id: 'project-1',
      name: '',
      description: '',
      status: 'active',
      created_at: '',
      updated_at: '',
      persona_count: 0,
      document_count: 0,
    })
    expect(result.personas).toEqual([
      expect.objectContaining({ persona_id: 'persona-1', name: '', tagline: '', created_at: '' }),
    ])
    expect(result.documents).toEqual([
      expect.objectContaining({
        document_id: 'document-1', document_type: 'custom', title: '', content: '', created_at: '',
      }),
    ])
  })

  it('infers a prototype from a legacy PROTOTYPE sort key', () => {
    const result = normalizeProjectDetail(envelope([], [{
      document_id: 'prototype-legacy',
      sk: 'PROTOTYPE#prototype-legacy',
      title: 'Checkout prototype (v1)',
    }]))

    expect(result.documents).toEqual([
      expect.objectContaining({
        document_id: 'prototype-legacy',
        document_type: 'prototype',
        sk: 'PROTOTYPE#prototype-legacy',
        title: 'Checkout prototype (v1)',
        content: '',
      }),
    ])
  })

  it('retains additive fields at every loose schema boundary', () => {
    const raw = {
      ...envelope(
        [{
          persona_id: 'persona-1',
          identity: { location: 'Paris', future_identity_field: 'kept' },
          future_persona_field: { enabled: true },
        }],
        [{
          document_id: 'document-1',
          document_type: 'research',
          future_document_field: ['kept'],
        }],
      ),
      future_envelope_field: 'kept',
      project: { project_id: 'project-1', future_project_field: 42 },
    }

    const result = normalizeProjectDetail(raw)

    expect(record(result).future_envelope_field).toBe('kept')
    expect(record(result.project).future_project_field).toBe(42)
    expect(record(result.personas[0]).future_persona_field).toEqual({ enabled: true })
    expect(record(result.personas[0].identity).future_identity_field).toBe('kept')
    expect(record(result.documents[0]).future_document_field).toEqual(['kept'])
  })

  it('keeps only string base titles and positive integral versions', () => {
    const result = normalizeProjectDetail(envelope([], [
      { document_id: 'valid', document_type: 'prd', base_title: 'Checkout', version: 2 },
      { document_id: 'zero', document_type: 'prd', base_title: 42, version: 0 },
      { document_id: 'negative', document_type: 'prd', version: -1 },
      { document_id: 'fractional', document_type: 'prd', version: 1.5 },
      { document_id: 'string', document_type: 'prd', version: '3' },
    ]))

    expect(result.documents.map((document) => ({
      id: document.document_id,
      baseTitle: document.base_title,
      version: document.version,
    }))).toEqual([
      { id: 'valid', baseTitle: 'Checkout', version: 2 },
      { id: 'zero', baseTitle: undefined, version: undefined },
      { id: 'negative', baseTitle: undefined, version: undefined },
      { id: 'fractional', baseTitle: undefined, version: undefined },
      { id: 'string', baseTitle: undefined, version: undefined },
    ])
  })

  it('normalizes omitted S3 prototype content to an empty string', () => {
    const prototypeUrl = 'https://cdn.example.com/prototypes/project-1/prototype-1.html'
    const result = normalizeProjectDetail(envelope([], [{
      document_id: 'prototype-1',
      document_type: 'prototype',
      title: 'Checkout prototype (v2)',
      prototype_url: prototypeUrl,
    }]))

    expect(result.documents[0].content).toBe('')
    expect(result.documents[0].prototype_url).toBe(prototypeUrl)
  })

  it('normalizes a malformed prototype URL to undefined without dropping the document', () => {
    const result = normalizeProjectDetail(envelope([], [{
      document_id: 'prototype-1',
      document_type: 'prototype',
      prototype_url: 'not a URL',
    }]))

    expect(result.documents.map((document) => document.document_id)).toEqual(['prototype-1'])
    expect(result.documents[0].prototype_url).toBeUndefined()
  })

  it('drops malformed row identities while preserving a persona with malformed optional identity data', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = normalizeProjectDetail(envelope(
      [
        { persona_id: 'persona-kept', identity: 'not an object' },
        { persona_id: '' },
        { name: 'missing id' },
      ],
      [
        { document_id: 'document-kept', document_type: 'custom' },
        { document_id: '', document_type: 'custom' },
        { document_id: 'missing-type' },
      ],
    ))

    expect(result.personas.map((persona) => persona.persona_id)).toEqual(['persona-kept'])
    expect(result.personas[0].identity).toBeUndefined()
    expect(result.documents.map((document) => document.document_id)).toEqual(['document-kept'])
    expect(warn).toHaveBeenCalledTimes(4)
    warn.mockRestore()
  })
})


test('preserves an unknown future document type instead of dropping the row', () => {
  const result = normalizeProjectDetail(envelope([], [{
    document_id: 'future-1',
    document_type: 'decision_record',
    title: 'Architecture decision',
  }]))

  expect(result.documents).toEqual([
    expect.objectContaining({
      document_id: 'future-1',
      document_type: 'decision_record',
    }),
  ])
})
