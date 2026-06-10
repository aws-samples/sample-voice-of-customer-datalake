/**
 * Tests for tool definitions.
 */
import { describe, it, expect } from 'vitest';
import { getSearchFeedbackTool, getUpdateDocumentTool, getCreateDocumentTool } from './index.js';

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
    expect(schema.required).toEqual([]);
  });

  it('defines sentiment enum values', () => {
    const tool = getSearchFeedbackTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.sentiment.enum).toEqual(['positive', 'negative', 'neutral', 'mixed']);
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
    expect(schema.required).toEqual(['document_id', 'content', 'summary']);
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
    expect(schema.required).toEqual(['title', 'content', 'document_type']);
  });

  it('defines document_type enum', () => {
    const tool = getCreateDocumentTool();
    const schema = tool.toolSpec?.inputSchema?.json as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.document_type.enum).toEqual(['prd', 'prfaq', 'custom']);
  });
});
