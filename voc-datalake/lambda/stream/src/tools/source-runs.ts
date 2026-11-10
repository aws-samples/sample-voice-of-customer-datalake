/**
 * Source run status rows (`SOURCE_RUN#{source}` / `{execution_id}` in the
 * aggregates table), written by `POST /sources/{source}/run` and the plugin
 * ingestors. Read directly: the stream role reads the aggregates table, and the
 * plan runtime's waits read the same rows.
 */
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

const rowSchema = z.record(z.string(), z.unknown());

const sourceRunKey = (source: string) => `SOURCE_RUN#${source}`;

function asRow(item: unknown): Record<string, unknown> | undefined {
  const row = rowSchema.safeParse(item);
  return row.success ? row.data : undefined;
}

/** One run (by execution id), or the newest run of the source; undefined when there is none. */
export async function readSourceRun(
  docClient: Pick<DynamoDBDocumentClient, 'send'>,
  tableName: string,
  source: string,
  executionId?: string,
): Promise<Record<string, unknown> | undefined> {
  if (executionId !== undefined) {
    const result = await docClient.send(new GetCommand({ TableName: tableName, Key: { pk: sourceRunKey(source), sk: executionId } }));
    return asRow(result.Item);
  }
  const result = await docClient.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': sourceRunKey(source) },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return asRow(result.Items?.[0]);
}
