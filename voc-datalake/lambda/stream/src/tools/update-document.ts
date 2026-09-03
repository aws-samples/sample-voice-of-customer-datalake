/**
 * update_document and create_document tool implementations.
 * Allows the AI to edit textual project documents or create custom documents
 * during chat. Prototype revisions stay on their dedicated S3-backed workflow.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { NotFoundError, ConfigurationError, ValidationError } from '../lib/errors.js';

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
  // Canonical PRDs and PR/FAQs use the Python generation path, where the
  // version counter and document row commit atomically. A direct TypeScript
  // writer would be a second allocator and could issue duplicate versions.
  document_type: z.literal('custom'),
});

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(item: Record<string, unknown>, key: string, fallback = ''): string {
  const val = item[key];
  return typeof val === 'string' ? val : fallback;
}

function hasManagedTitle(item: Record<string, unknown>, sk: string): boolean {
  const documentType = getString(item, 'document_type');
  return documentType === 'prd' || documentType === 'prfaq'
    || sk.startsWith('PRD#') || sk.startsWith('PRFAQ#');
}

interface DocumentUpdateTarget {
  sk: string;
  title: string;
}

function resolveDocumentUpdateTarget(
  items: unknown[],
  documentId: string,
  requestedTitle: string | undefined,
): DocumentUpdateTarget {
  if (items.length === 0) {
    throw new NotFoundError(`Document '${documentId}' not found in project`);
  }

  const document = items[0];
  if (!isRecord(document)) throw new NotFoundError('Invalid document record');

  const sk = getString(document, 'sk');
  if (!sk) throw new NotFoundError('Invalid document record');

  const isPrototype = getString(document, 'document_type') === 'prototype'
    || sk.startsWith('PROTOTYPE#');
  if (isPrototype) {
    throw new ValidationError(
      'Prototype HTML is stored in S3 and cannot be edited with update_document. '
      + 'Use the prototype revision workflow.',
    );
  }
  if (hasManagedTitle(document, sk) && requestedTitle !== undefined) {
    throw new ValidationError(
      'Versioned PRD and PR/FAQ titles cannot be renamed. Generate a new document to start a new titled series.',
    );
  }

  return {
    sk,
    title: requestedTitle ?? getString(document, 'title', 'Untitled'),
  };
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

async function sendExistingDocumentUpdate(
  docClient: DynamoDBDocumentClient,
  input: UpdateCommandInput,
): Promise<void> {
  try {
    await docClient.send(new UpdateCommand(input));
  } catch (error) {
    if (isConditionalFailure(error)) {
      throw new NotFoundError('Document no longer exists');
    }
    throw error;
  }
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
  const { sk, title: documentTitle } = resolveDocumentUpdateTarget(items, documentId, title);
  const now = new Date().toISOString();

  // Build update expression
  const exprNames: Record<string, string> = { '#content': 'content' };
  const exprValues: Record<string, string> = {
    ':content': content,
    ':now': now,
    ':documentId': documentId,
  };
  const updateParts = ['#content = :content', 'updated_at = :now'];

  if (title) {
    updateParts.push('title = :title');
    exprValues[':title'] = title;
  }

  await sendExistingDocumentUpdate(docClient, {
    TableName: projectsTable,
    Key: { pk: `PROJECT#${projectId}`, sk },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ConditionExpression: (
      'attribute_exists(pk) AND attribute_exists(sk) '
      + 'AND document_id = :documentId'
    ),
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
  });

  return {
    content: `Successfully updated document "${documentTitle}". Changes: ${summary}`,
    documentChange: {
      document_id: documentId,
      title: documentTitle,
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
  const docId = `doc_${now.replaceAll(/[-:T.Z]/g, '').slice(0, 14)}`;

  const item = {
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
  };
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: projectsTable,
            Item: item,
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        },
        {
          Update: {
            TableName: projectsTable,
            Key: { pk: `PROJECT#${projectId}`, sk: 'META' },
            UpdateExpression: (
              'SET document_count = if_not_exists(document_count, :zero) + :one, '
              + 'updated_at = :now'
            ),
            ConditionExpression: (
              'attribute_exists(pk) AND attribute_exists(sk) '
              + 'AND attribute_not_exists(#deleting) '
              + 'AND (attribute_not_exists(#status) OR '
              + '(#status <> :deletingStatus AND #status <> :deletedStatus))'
            ),
            ExpressionAttributeNames: {
              '#deleting': 'deletion_started_at',
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':zero': 0,
              ':one': 1,
              ':now': now,
              ':deletingStatus': 'deleting',
              ':deletedStatus': 'deleted',
            },
          },
        },
      ],
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
