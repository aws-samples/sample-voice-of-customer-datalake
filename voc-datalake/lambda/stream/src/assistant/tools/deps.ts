/**
 * External dependencies of the tool catalogue, injected so every tool can be
 * exercised end-to-end in tests with fakes (no module mocking).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { getBedrockClient } from '../../bedrock/converse-stream.js';
import { resolveAvatarUrl } from '../../context/avatar-url.js';
import { executeSearchFeedback } from '../../tools/search-feedback.js';
import { executeWebSearch, type WebSource } from '../../tools/web-search.js';
import type { FeedbackItem } from '../../tools/feedback-scan.js';
import type { CategoryScope } from '../../tools/category-scope.js';
import { getInternalApiInvoker, type ApiInvoker } from './internal-api.js';

interface SearchFilters {
  /** The caller's readable categories — required, so no call site reads every category by default. */
  scope: CategoryScope;
  days?: number;
  dateBasis?: 'imported' | 'review';
}

export interface ToolDeps {
  invoke: ApiInvoker;
  searchFeedback(input: unknown, filters: SearchFilters): Promise<{ items: FeedbackItem[]; formatted: string }>;
  webSearch(input: unknown): Promise<{ content: string; webSources: WebSource[] }>;
  converse(command: ConverseCommand): Promise<ConverseCommandOutput>;
  resolveAvatar(url: string | undefined): Promise<string | undefined>;
  /** Used by consult_personas only when the run has no resolved model. */
  fallbackModelId: string | undefined;
}

const holder: { deps?: ToolDeps } = {};

function createDefaultDeps(): ToolDeps {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const feedbackTable = process.env.FEEDBACK_TABLE ?? '';
  return {
    invoke: getInternalApiInvoker(),
    searchFeedback: (input, filters) => executeSearchFeedback(docClient, feedbackTable, input, filters),
    webSearch: (input) => executeWebSearch(input),
    converse: (command) => getBedrockClient().send(command),
    resolveAvatar: resolveAvatarUrl,
    fallbackModelId: process.env.BEDROCK_MODEL_ID,
  };
}

/** Process-wide dependencies (lazy, so importing the catalogue opens no clients). */
export function getDefaultToolDeps(): ToolDeps {
  holder.deps ??= createDefaultDeps();
  return holder.deps;
}
