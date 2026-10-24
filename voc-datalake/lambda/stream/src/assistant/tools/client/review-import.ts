/**
 * `import_reviews` (`scrapers` pack, admin-only like manual import): the model
 * extracts reviews from text the user pasted or a file they attached (CSV,
 * spreadsheet, document, PDF — Bedrock reads it) and proposes them as rows. The
 * SPA shows a deterministic table and, on approval, sends them to the existing
 * `POST /scrapers/manual/json-upload` route with the user's own token; the
 * executor derives each row's de-duplication id, so importing the same rows
 * twice stores them once.
 *
 * Card-only (`CARD_ONLY_WRITE_TOOLS`): the rows come from this conversation,
 * there can be 500 of them, and they are only ever approved as shown.
 *
 * Precheck: a named `source_id` must be a configured source profile
 * (`GET /settings/sources`, read as the caller); omitted files the rows under
 * `manual_import`, like Settings' manual import.
 */
import type { AssistantRunContext, ClientToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { getSettingsRoute } from '../server/common.js';
import { recordsAt } from '../server/feedback-shape.js';
import { defineClientTool, q, stringProperty } from './define.js';
import type { JsonSchemaProperties } from '../spec.js';
import { DEFAULT_IMPORT_SOURCE_ID, REVIEW_IMPORT_LIMITS as L, importReviewsArgsSchema } from './review-import-schemas.js';
import { USER_LIMITS } from './user-schemas.js';

/** The longest ISO 8601 date-time isReviewDate admits is 32 characters; the model is told this cap. */
const MAX_DATE_CHARS = 32;

async function configuredSourceIds(deps: ToolDeps, ctx: AssistantRunContext): Promise<string[]> {
  const body = await getSettingsRoute(deps, ctx, 'sources');
  return recordsAt(body, 'sources').flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : []));
}

/** The refusal for a `source_id` that is not a configured profile, else undefined. */
async function unknownSourceId(deps: ToolDeps, ctx: AssistantRunContext, sourceId: string | undefined): Promise<string | undefined> {
  if (sourceId === undefined || sourceId === DEFAULT_IMPORT_SOURCE_ID) return undefined;
  const known = await configuredSourceIds(deps, ctx);
  if (known.includes(sourceId)) return undefined;
  const listed = known.length === 0 ? 'No source profiles are configured.' : `The configured source profiles are: ${known.join(', ')}.`;
  return `unknown source_id "${sourceId}". ${listed} Omit source_id to file the reviews under ${DEFAULT_IMPORT_SOURCE_ID}.`;
}

const ITEM_PROPERTIES: JsonSchemaProperties = {
  text: stringProperty(`The review text exactly as written (1-${L.maxTextChars} characters). Never invent or rewrite reviews.`, L.maxTextChars),
  rating: { type: 'number', minimum: L.minRating, maximum: L.maxRating, description: `Star rating (${L.minRating}-${L.maxRating}) when the source gives one.` },
  author: stringProperty('Reviewer name or handle, when given.', L.maxAuthorChars),
  created_at: stringProperty('Review date as ISO 8601 (YYYY-MM-DD or a date-time), when given. Never guessed.', MAX_DATE_CHARS),
  url: stringProperty('Link to the review (http/https), when given.', L.maxUrlChars),
  title: stringProperty('Review headline, when given.', L.maxTitleChars),
};

export function createReviewImportClientTools(deps: ToolDeps): ClientToolDefinition[] {
  return [defineClientTool({
    name: 'import_reviews',
    pack: 'scrapers',
    description: 'Import customer reviews into the data lake (admin): rows you extracted from text the user pasted or a '
      + `file they attached. Up to ${L.maxItems} reviews per call (split larger sets into several calls), text copied `
      + 'verbatim — never summarised, merged or invented. Leave a field out when the source does not give it; a review '
      + 'without a date is dated at import. source_name says where the reviews came from (e.g. "Trustpilot", '
      + '"Support survey Q3"). The reviews go through the normal enrichment pipeline and appear within minutes.',
    properties: {
      source_name: stringProperty('Where the reviews came from (shown as their channel).', L.maxSourceNameChars),
      source_id: stringProperty('Optional configured source profile id (Administration → Privacy & access → Source policies) to file them under; omit for manual_import.', USER_LIMITS.maxSourceIdLength),
      items: { type: 'array', minItems: 1, maxItems: L.maxItems, items: { type: 'object', properties: ITEM_PROPERTIES, required: ['text'], additionalProperties: false } },
    },
    required: ['source_name', 'items'],
    schema: importReviewsArgsSchema,
    precheck: (args, ctx) => unknownSourceId(deps, ctx, args.source_id),
    summarize: (args) => `Import ${args.items.length} review${args.items.length === 1 ? '' : 's'} from ${q(args.source_name)}.`,
  })];
}
