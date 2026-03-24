/**
 * update_document and create_document tool implementations.
 * Allows the AI to edit or create project documents during chat.
 */
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { NotFoundError, ConfigurationError } from '../lib/errors.js';

// ── Input schemas ──

const updateDocumentInputSchema = z.object({
  document_id: z.string().min(1),
  title: z.string().optional(),
  content: z.string().min(1),
  summary: z.string().min(1),
});

const createDocumentInputSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  document_type: z.enum(['prd', 'prfaq', 'custom']),
});

export type UpdateDocumentInput = z.infer<typeof updateDocumentInputSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

// ── Result type ──

export interface DocumentToolResult {
  content: string;
  documentChange: DocumentChange;
}

export interface DocumentChange {
  document_id: string;
  title: string;
  action: 'updated' | 'created';
  summary: string;
}

// ── Helpers ──

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null;
}

function getString(item: Record<string, unknown>, key: string, fallback = ''): string {
  const val = item[key];
  return typeof val === 'string' ? val : fallback;
}

// ── update_document ──

export async function executeUpdateDocument(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  projectId: string,
  toolInput: unknown,
): Promise<DocumentToolResult> {
  if (!projectsTable) throw new ConfigurationError('Projects table not configured');

  const parsed = updateDocumentInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return {
      content: `Invalid input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      documentChange: { document_id: '', title: '', action: 'updated', summary: 'Failed - invalid input' },
    };
  }

  const { document_id: documentId, title, content, summary } = parsed.data;

  // Find the document's sort key
  const resp = await docClient.send(
    new QueryCommand({
      TableName: projectsTable,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'document_id = :docId',
      ExpressionAttributeValues: {
        ':pk': `PROJECT#${projectId}`,
        ':docId': documentId,
      },
    }),
  );

  const items = resp.Items ?? [];
  console.log(`update_document: queried PROJECT#${projectId} for doc ${documentId}, found ${items.length} items`);
  if (items.length === 0) {
    throw new NotFoundError(`Document '${documentId}' not found in project`);
  }

  const doc = items[0];
  if (!isStringRecord(doc)) throw new NotFoundError('Invalid document record');
  const sk = getString(doc, 'sk');
  const docTitle = title ?? getString(doc, 'title', 'Untitled');
  const now = new Date().toISOString();

  // Build update expression
  const exprNames: Record<string, string> = { '#content': 'content' };
  const exprValues: Record<string, string> = { ':content': content, ':now': now };
  const updateParts = ['#content = :content', 'updated_at = :now'];

  if (title) {
    updateParts.push('title = :title');
    exprValues[':title'] = title;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: projectsTable,
      Key: { pk: `PROJECT#${projectId}`, sk },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }),
  );

  return {
    content: `Successfully updated document "${docTitle}". Changes: ${summary}`,
    documentChange: {
      document_id: documentId,
      title: docTitle,
      action: 'updated',
      summary,
    },
  };
}

// ── create_document ──

export async function executeCreateDocument(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  projectId: string,
  toolInput: unknown,
): Promise<DocumentToolResult> {
  if (!projectsTable) throw new ConfigurationError('Projects table not configured');

  const parsed = createDocumentInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return {
      content: `Invalid input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      documentChange: { document_id: '', title: '', action: 'created', summary: 'Failed - invalid input' },
    };
  }

  const { title, content, document_type: docType } = parsed.data;
  const now = new Date().toISOString();
  const docId = `doc_${now.replace(/[-:T.Z]/g, '').slice(0, 14)}`;

  await docClient.send(
    new PutCommand({
      TableName: projectsTable,
      Item: {
        pk: `PROJECT#${projectId}`,
        sk: `DOC#${docId}`,
        gsi1pk: `PROJECT#${projectId}#DOCUMENTS`,
        gsi1sk: now,
        document_id: docId,
        document_type: docType,
        title,
        content,
        created_at: now,
        updated_at: now,
      },
    }),
  );

  // Increment document count
  await docClient.send(
    new UpdateCommand({
      TableName: projectsTable,
      Key: { pk: `PROJECT#${projectId}`, sk: 'META' },
      UpdateExpression: 'SET document_count = document_count + :one, updated_at = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': now },
    }),
  );

  return {
    content: `Successfully created new ${docType.toUpperCase()} document "${title}".`,
    documentChange: {
      document_id: docId,
      title,
      action: 'created',
      summary: `Created new ${docType} document`,
    },
  };
}
