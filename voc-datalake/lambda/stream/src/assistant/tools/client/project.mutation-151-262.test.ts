/**
 * Mutation hardening of the `project` pack's background-job tools (start_research,
 * generate_document, generate_personas, merge_documents).
 *
 * The run found that nothing pinned what these tools ADVERTISE to the model —
 * descriptions, property schemas, enums and required lists could be emptied
 * unnoticed — nor the trim on their text fields, the second enum values, the
 * title bounds, or either branch of the summaries' conditionals (PRD vs PR/FAQ,
 * persona vs personas, with or without web search).
 */
import { describe, expect, it } from 'vitest';
import { clientToolLookup, fakeContext } from '../test-fixtures.js';
import {
  PROJECT_ID_PROP,
  expectSpec,
  expectStringBound,
  idListProp,
  itTrimsAndBounds,
  outcome,
  summaryOf,
  textProp,
} from './spec-mutation-fixtures.js';

const tool = clientToolLookup();
const projectPage = fakeContext('project', { projectId: 'proj_1' });

const RESEARCH = { question: 'Why do users churn?' };
const GENERATE = { doc_type: 'prd', title: 'Checkout PRD', feature_idea: 'One-click checkout' };
const MERGE = { output_type: 'prd', title: 'Merged', instructions: 'Combine', document_ids: ['d1', 'd2'] };

describe('the background-job tools advertise their exact schema', () => {
  it('start_research', () => {
    expectSpec(tool('start_research'), {
      description: 'Start a background research job that analyses the feedback (and optionally the web) to answer a '
        + 'question; it produces a research document. Track it with list_project_jobs.',
      properties: {
        project_id: PROJECT_ID_PROP,
        question: textProp('The research question.', 2000),
        title: textProp('Title of the research document.', 200),
        persona_ids: idListProp('Personas to take into account.', 20),
        document_ids: idListProp('Documents to use as context.', 20),
        use_web_search: { type: 'boolean', description: 'Also search the public web.' },
      },
      required: ['project_id', 'question'],
    });
  });

  it('generate_document', () => {
    expectSpec(tool('generate_document'), {
      description: 'Start a background job that writes a PRD or PR/FAQ for a feature idea from the feedback, personas '
        + 'and selected documents.',
      properties: {
        project_id: PROJECT_ID_PROP,
        doc_type: { type: 'string', enum: ['prd', 'prfaq'], description: 'Document type.' },
        title: textProp('Document title.', 200),
        feature_idea: textProp('The feature idea to write up.', 4000),
        persona_ids: idListProp('Personas to write for.', 20),
        document_ids: idListProp('Documents to use as context.', 20),
      },
      required: ['project_id', 'doc_type', 'title', 'feature_idea'],
    });
  });

  it('generate_personas', () => {
    expectSpec(tool('generate_personas'), {
      description: 'Start a background job that derives new personas from the feedback in the page time window.',
      properties: {
        project_id: PROJECT_ID_PROP,
        persona_count: { type: 'integer', minimum: 1, maximum: 8, description: 'How many personas (1-8).' },
        custom_instructions: textProp('Extra guidance for the generator.', 2000),
      },
      required: ['project_id', 'persona_count'],
    });
  });

  it('merge_documents', () => {
    expectSpec(tool('merge_documents'), {
      description: 'Start a background job that merges 2-10 project documents into a new PRD, PR/FAQ or custom document.',
      properties: {
        project_id: PROJECT_ID_PROP,
        output_type: { type: 'string', enum: ['prd', 'prfaq', 'custom'], description: 'Type of the merged document.' },
        title: textProp('Title of the merged document.', 200),
        instructions: textProp('How to merge.', 4000),
        document_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10, description: 'Documents to merge.' },
        persona_ids: idListProp('Personas to take into account.', 20),
      },
      required: ['project_id', 'output_type', 'title', 'instructions', 'document_ids'],
    });
  });
});

describe('the text fields are trimmed and bounded', () => {
  itTrimsAndBounds([
    ['start_research', RESEARCH, 'question', 2000],
    ['start_research', RESEARCH, 'title', 200],
    ['generate_document', GENERATE, 'title', 200],
    ['generate_document', GENERATE, 'feature_idea', 4000],
    ['merge_documents', MERGE, 'title', 200],
    ['merge_documents', MERGE, 'instructions', 4000],
  ], tool, () => projectPage);

  it('generate_personas bounds custom_instructions at 2000 characters', () => {
    expectStringBound(tool('generate_personas'), projectPage, {
      base: { persona_count: 2 }, field: 'custom_instructions', max: 2000, trimmed: false,
    });
  });
});

describe('every enum value is accepted', () => {
  it.each(['prd', 'prfaq'])('generate_document doc_type %s', (docType) => {
    expect(outcome(tool('generate_document').validate({ ...GENERATE, doc_type: docType }, projectPage)))
      .toMatchObject({ doc_type: docType });
  });

  it.each(['prd', 'prfaq', 'custom'])('merge_documents output_type %s', (outputType) => {
    expect(outcome(tool('merge_documents').validate({ ...MERGE, output_type: outputType }, projectPage)))
      .toMatchObject({ output_type: outputType });
  });
});

describe('the summaries name the job and both branches of their conditionals', () => {
  const summary = (name: string, args: Record<string, unknown>) => summaryOf(tool(name), projectPage, args);

  it.each<[Record<string, unknown>, string]>([
    [RESEARCH, "Start research in project proj_1: 'Why do users churn?'."],
    [{ ...RESEARCH, use_web_search: false }, "Start research in project proj_1: 'Why do users churn?'."],
    [{ ...RESEARCH, use_web_search: true }, "Start research in project proj_1: 'Why do users churn?' (with web search)."],
  ])('start_research %o', (args, expected) => {
    expect(summary('start_research', args)).toBe(expected);
  });

  it.each<[string, string]>([
    ['prd', "Generate a PRD 'Checkout PRD' in project proj_1."],
    ['prfaq', "Generate a PR/FAQ 'Checkout PRD' in project proj_1."],
  ])('generate_document %s', (docType, expected) => {
    expect(summary('generate_document', { ...GENERATE, doc_type: docType })).toBe(expected);
  });

  it.each<[number, string]>([
    [1, 'Generate 1 persona in project proj_1.'],
    [2, 'Generate 2 personas in project proj_1.'],
  ])('generate_personas %i', (count, expected) => {
    expect(summary('generate_personas', { persona_count: count })).toBe(expected);
  });

  it('merge_documents', () => {
    expect(summary('merge_documents', { ...MERGE, output_type: 'custom' }))
      .toBe("Merge 2 documents into 'Merged' (custom) in project proj_1.");
  });
});
