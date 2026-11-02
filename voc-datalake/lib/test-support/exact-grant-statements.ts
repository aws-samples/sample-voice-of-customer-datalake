/**
 * Test support for lib/utils/exact-grants.ts: one synthesized IAM statement (with its Condition), its actions,
 * and the KMS statements a CMK-encrypted DynamoDB read/write grant must render as.
 */
import { z } from 'zod';

export const GrantStatementSchema = z.looseObject({
  Effect: z.string(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
  Condition: z.unknown().optional(),
});
export type GrantStatement = z.infer<typeof GrantStatementSchema>;

export const grantActions = (statement: GrantStatement): string[] =>
  (typeof statement.Action === 'string' ? [statement.Action] : statement.Action);

/** `[actions, condition | null]` of each KMS statement, in order. */
export const kmsGrants = (statements: readonly GrantStatement[]) => statements
  .filter((statement) => grantActions(statement).some((action) => action.startsWith('kms:')))
  .map((statement) => [grantActions(statement), statement.Condition ?? null]);

/** {@link kmsGrants} of a role that reads and writes a table encrypted with a customer managed key. */
export const cmkTableReadWriteKms = (region: string) => [
  [['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey'], null],
  [['kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncryptFrom', 'kms:ReEncryptTo'],
    { StringEquals: { 'kms:ViaService': `dynamodb.${region}.amazonaws.com` } }],
];
