/**
 * Mutation pins for the `GET /projects/{id}` shaper.
 *
 * The Stryker run found what the get_project suite could not see: an
 * unreadable body (no `project` record) was never fed in, junk persona and
 * document rows were never mixed in, and every prototype in the fixtures had
 * BOTH `document_type: 'prototype'` and a `PROTOTYPE#` sort key, so neither
 * half of `isPrototype` was pinned on its own (nor `startsWith` vs `endsWith`).
 */
import { describe, expect, it } from 'vitest';
import { isPrototype, parseProjectPayload, summarizeProject } from './project-shape.js';

describe('parseProjectPayload refuses a body without a project record', () => {
  it.each([
    ['null', null],
    ['no project', { personas: [], documents: [] }],
    ['a non-record project', { project: 'p1' }],
  ])('%s', (_label, body) => {
    expect(() => parseProjectPayload(body)).toThrow(expect.objectContaining({
      code: 'unavailable',
      message: 'The Projects API returned an unreadable project.',
    }));
  });
});

describe('parseProjectPayload keeps only record rows', () => {
  it('drops non-record personas and documents and defaults missing lists to none', () => {
    expect(parseProjectPayload({
      project: { name: 'Checkout' },
      personas: [{ persona_id: 'p1' }, 'junk', null, ['x']],
      documents: [7, { document_id: 'd1' }],
    })).toStrictEqual({
      project: { name: 'Checkout' },
      personas: [{ persona_id: 'p1' }],
      documents: [{ document_id: 'd1' }],
    });
    expect(parseProjectPayload({ project: {}, personas: 'none' })).toStrictEqual({ project: {}, personas: [], documents: [] });
  });
});

describe('isPrototype', () => {
  it.each([
    ['the document type alone', { document_type: 'prototype' }, true],
    ['the sort key alone', { sk: 'PROTOTYPE#x' }, true],
    ['a sort key that only ends with the prefix', { sk: 'DOC#PROTOTYPE#' }, false],
    ['a non-string sort key', { sk: 7, document_type: 'prd' }, false],
    ['another type and key', { sk: 'PRD#d1', document_type: 'prd' }, false],
  ])('%s', (_label, document, expected) => {
    expect(isPrototype(document)).toBe(expected);
  });
});

describe('summarizeProject', () => {
  it('reports access first and marks a sort-key-only prototype without its size', () => {
    const summary = summarizeProject({
      project: { project_id: 'proj_1', access: { role: 'viewer', can_edit: false, can_manage: false } },
      personas: ['junk'],
      documents: [{ document_id: 'x', sk: 'PROTOTYPE#x', content: '<html>' }, { document_id: 'd2', content: 7 }],
    });
    expect(Object.keys(summary)).toStrictEqual(['access', 'project', 'personas', 'documents']);
    expect(summary).toStrictEqual({
      access: { role: 'viewer', can_edit: false, can_manage: false },
      project: { project_id: 'proj_1' },
      personas: [],
      documents: [{ document_id: 'x', prototype: true }, { document_id: 'd2', content_chars: 0 }],
    });
  });
});
