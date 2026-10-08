/**
 * One day's partition of the feedback by-date GSI, newest first.
 *
 * The processor writes `gsi1pk = 'DATE#YYYY-MM-DD'`, so every "recent" read in
 * this Lambda is a walk over day partitions — context/recent-feedback.ts stops
 * at a target count (`Limit`), tools/feedback-scan.ts pages a whole day
 * (`ExclusiveStartKey`). Both build the command here so the key shape lives in
 * one place.
 */
import { QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { FEEDBACK_BY_DATE_INDEX } from './indexes.js';

export function feedbackByDateQuery(
  feedbackTable: string,
  dateStr: string,
  paging: Pick<QueryCommandInput, 'Limit' | 'ExclusiveStartKey'>,
): QueryCommand {
  return new QueryCommand({
    TableName: feedbackTable,
    IndexName: FEEDBACK_BY_DATE_INDEX,
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `DATE#${dateStr}` },
    ScanIndexForward: false,
    ...paging,
  });
}
