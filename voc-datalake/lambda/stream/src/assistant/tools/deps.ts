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
import { searchAppStore, type AppStoreApp } from '../../tools/app-store-search.js';
import { lookupStoreApp, type StoreAppLookup } from '../../tools/store-app-lookup.js';
import { readSourceRun } from '../../tools/source-runs.js';
import type { FeedbackItem } from '../../tools/feedback-scan.js';
import type { CategoryScope } from '../../tools/category-scope.js';
import { getInternalApiInvoker, type ApiInvoker } from './internal-api.js';
import type { FeedbackFloor } from './server/feedback-floor.js';

interface SearchFilters {
  /** The caller's readable categories — required, so no call site reads every category by default. */
  scope: CategoryScope;
  days?: number;
  dateBasis?: 'imported' | 'review';
  /** Category id → display label, shown beside the id in the formatted result. */
  categoryLabel?: (id: string) => string;
  /** The user's on-screen filters, a floor the model's arguments cannot widen (server/feedback-floor.ts). */
  floor?: FeedbackFloor;
  /** At most this many matching reviews are used (the /chat panel's `limit`). */
  readLimit?: number;
}

export interface ToolDeps {
  invoke: ApiInvoker;
  searchFeedback(input: unknown, filters: SearchFilters): Promise<{ items: FeedbackItem[]; formatted: string }>;
  webSearch(input: unknown): Promise<{ content: string; webSources: WebSource[] }>;
  converse(command: ConverseCommand): Promise<ConverseCommandOutput>;
  resolveAvatar(url: string | undefined): Promise<string | undefined>;
  /** Used by consult_personas only when the run has no resolved model. */
  fallbackModelId: string | undefined;
  /** Apple's iTunes Search API (find_app_store_app; fixed host, bounded). */
  searchAppStore(term: string, country: string): Promise<AppStoreApp[]>;
  /** Does this App Store id / Google Play package exist (create_app_connector's precheck; fixed hosts, bounded)? */
  lookupStoreApp(platform: 'ios' | 'android', id: string): Promise<StoreAppLookup>;
  /** A `SOURCE_RUN#{source}` row of the aggregates table (get_source_run); newest when no execution id. */
  readSourceRun(source: string, executionId?: string): Promise<Record<string, unknown> | undefined>;
  /** Wall clock (epoch ms) and a pause, for tools that poll a background job. */
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

const holder: { deps?: ToolDeps } = {};

function createDefaultDeps(): ToolDeps {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const feedbackTable = process.env.FEEDBACK_TABLE ?? '';
  const aggregatesTable = process.env.AGGREGATES_TABLE ?? '';
  return {
    invoke: getInternalApiInvoker(),
    searchFeedback: (input, filters) => executeSearchFeedback(docClient, feedbackTable, input, filters),
    webSearch: (input) => executeWebSearch(input),
    converse: (command) => getBedrockClient().send(command),
    resolveAvatar: resolveAvatarUrl,
    fallbackModelId: process.env.BEDROCK_MODEL_ID,
    searchAppStore: (term, country) => searchAppStore(term, country),
    lookupStoreApp,
    readSourceRun: (source, executionId) => readSourceRun(docClient, aggregatesTable, source, executionId),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  };
}

/** Process-wide dependencies (lazy, so importing the catalogue opens no clients). */
export function getDefaultToolDeps(): ToolDeps {
  holder.deps ??= createDefaultDeps();
  return holder.deps;
}
