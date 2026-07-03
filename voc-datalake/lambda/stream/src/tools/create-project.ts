/**
 * create_project tool implementation.
 *
 * Lets the VoC chat turn analysis into action: when the user says "make a
 * project out of this", the model creates a project and seeds its product
 * context (the same PRODUCT_CONTEXT item the Product tab's interview fills),
 * so the project starts pre-populated instead of blank.
 *
 * Writes mirror lambda/api/projects.py::create_project (META item) and
 * lambda/api/product_context.py (sk='PRODUCT_CONTEXT' item) so the project
 * shows up in the normal Projects list and Product tab.
 */
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ConfigurationError } from '../lib/errors.js';

// Field length caps mirror lambda/api/product_context.py STRING_FIELDS so the
// seeded draft stays consistent with what the Product tab interview accepts.
const createProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // Optional product-context seed fields (all free text, drafted from feedback).
  product_name: z.string().max(200).optional(),
  one_liner: z.string().max(200).optional(),
  target_users: z.string().max(1000).optional(),
  problem_solved: z.string().max(2000).optional(),
  key_features: z.string().max(2000).optional(),
});

export interface ProjectChange {
  project_id: string;
  name: string;
  action: 'created';
  summary: string;
}

export interface CreateProjectResult {
  content: string;
  projectChange: ProjectChange;
}

const PRODUCT_CONTEXT_FIELDS = [
  'product_name',
  'one_liner',
  'target_users',
  'problem_solved',
  'key_features',
] as const;

export async function executeCreateProject(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  toolInput: unknown,
): Promise<CreateProjectResult> {
  if (!projectsTable) throw new ConfigurationError('Projects table not configured');

  const parsed = createProjectInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return {
      content: `Invalid input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      projectChange: { project_id: '', name: '', action: 'created', summary: 'Failed - invalid input' },
    };
  }

  const input = parsed.data;
  const now = new Date().toISOString();
  // Match projects.py id format: proj_YYYYMMDDHHMMSS
  const projectId = `proj_${now.replace(/[-:T.Z]/g, '').slice(0, 14)}`;

  // 1) Project META — same shape as projects.py::create_project so it lists normally.
  await docClient.send(
    new PutCommand({
      TableName: projectsTable,
      Item: {
        pk: `PROJECT#${projectId}`,
        sk: 'META',
        gsi1pk: 'TYPE#PROJECT',
        gsi1sk: now,
        project_id: projectId,
        name: input.name,
        description: input.description ?? '',
        status: 'active',
        created_at: now,
        updated_at: now,
        persona_count: 0,
        document_count: 0,
        filters: {},
        kiro_export_prompt: '',
      },
    }),
  );

  // 2) Optional PRODUCT_CONTEXT seed — only the fields the model actually drafted.
  const seeded: string[] = [];
  const contextItem: Record<string, unknown> = {
    pk: `PROJECT#${projectId}`,
    sk: 'PRODUCT_CONTEXT',
    updated_at: now,
  };
  for (const field of PRODUCT_CONTEXT_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) {
      contextItem[field] = value.trim();
      seeded.push(field);
    }
  }
  if (seeded.length > 0) {
    await docClient.send(new PutCommand({ TableName: projectsTable, Item: contextItem }));
  }

  const seedNote = seeded.length > 0
    ? ` Seeded product context: ${seeded.join(', ')}.`
    : '';

  return {
    content: `Successfully created project "${input.name}" (id: ${projectId}).${seedNote} `
      + `The user can open it from the Projects list; the Product tab is pre-filled with the drafted context.`,
    projectChange: {
      project_id: projectId,
      name: input.name,
      action: 'created',
      summary: seeded.length > 0
        ? `Created project and seeded ${seeded.length} product-context field(s)`
        : 'Created project',
    },
  };
}
