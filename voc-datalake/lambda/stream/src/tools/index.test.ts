/**
 * Tests for tool definitions.
 */
import { describe, it, expect } from 'vitest';
import { getSearchFeedbackTool, getUpdateDocumentTool, getCreateDocumentTool, getCreateProjectTool, getWebSearchTool } from './index.js';

describe('getWebSearchTool', () => {
  it('returns a tool with name web_search that requires query', () => {
    const tool = getWebSearchTool();
    expect(tool.toolSpec?.name).toBe('web_search');
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    expect(schema.required).toStrictEqual(['query']);
  });

  it('instructs the model to search iteratively, not one-shot (#207)', () => {
    // The agentic tool loop supports many rounds; without this instruction
    // the model tends to fire one broad query and settle.
    const description = getWebSearchTool().toolSpec?.description ?? '';
    expect(description).toMatch(/MULTIPLE\s+times/);
    expect(description).toMatch(/refine/i);
    expect(description).toMatch(/several specific queries over one broad one/i);
  });

  it('keeps the citation mandate and the 200-character query cap', () => {
    const description = getWebSearchTool().toolSpec?.description ?? '';
    expect(description).toMatch(/cite the source URLs/i);
    expect(description).toMatch(/200 characters/);
  });

  it('defers customer-feedback questions to search_feedback', () => {
    const description = getWebSearchTool().toolSpec?.description ?? '';
    expect(description).toContain('search_feedback');
  });
});

describe('getCreateProjectTool', () => {
  it('returns a tool with name create_project', () => {
    expect(getCreateProjectTool().toolSpec?.name).toBe('create_project');
  });

  it('requires only name', () => {
    const schema = getCreateProjectTool().toolSpec?.inputSchema?.json as Record<string, unknown>;
    expect(schema.required).toStrictEqual(['name']);
  });

  it('exposes product-context seed fields', () => {
    const schema = getCreateProjectTool().toolSpec?.inputSchema?.json as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    for (const f of ['name', 'description', 'product_name', 'one_liner', 'target_users', 'problem_solved', 'key_features']) {
      expect(props[f]).toBeDefined();
    }
  });
});

describe('getSearchFeedbackTool', () => {
  it('returns a tool with name search_feedback', () => {
    const tool = getSearchFeedbackTool();
    expect(tool.toolSpec?.name).toBe('search_feedback');
  });

  it('has a description', () => {
    const tool = getSearchFeedbackTool();
    expect(tool.toolSpec?.description).toBeTruthy();
  });

  it('defines query, source, category, sentiment, urgency, and limit properties', () => {
    const tool = getSearchFeedbackTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props.query).toBeDefined();
    expect(props.source).toBeDefined();
    expect(props.category).toBeDefined();
    expect(props.sentiment).toBeDefined();
    expect(props.urgency).toBeDefined();
    expect(props.limit).toBeDefined();
  });

  it('has no required fields', () => {
    const tool = getSearchFeedbackTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    expect(schema.required).toStrictEqual([]);
  });

  it('defines sentiment enum values', () => {
    const tool = getSearchFeedbackTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.sentiment.enum).toStrictEqual(['positive', 'negative', 'neutral', 'mixed']);
  });
});

describe('getUpdateDocumentTool', () => {
  it('returns a tool with name update_document', () => {
    const tool = getUpdateDocumentTool();
    expect(tool.toolSpec?.name).toBe('update_document');
  });

  it('requires document_id, content, and summary', () => {
    const tool = getUpdateDocumentTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    expect(schema.required).toStrictEqual(['document_id', 'content', 'summary']);
  });
});

describe('getCreateDocumentTool', () => {
  it('returns a tool with name create_document', () => {
    const tool = getCreateDocumentTool();
    expect(tool.toolSpec?.name).toBe('create_document');
  });

  it('requires title, content, and document_type', () => {
    const tool = getCreateDocumentTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    expect(schema.required).toStrictEqual(['title', 'content', 'document_type']);
  });

  it('defines document_type enum', () => {
    const tool = getCreateDocumentTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.document_type.enum).toStrictEqual(['prd', 'prfaq', 'custom']);
  });
});
