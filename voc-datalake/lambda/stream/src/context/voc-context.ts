/**
 * VoC Chat context builder.
 * Ported from Python chat_stream_handler.py get_voc_chat_context().
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

const SENTIMENT_LABELS = ['positive', 'negative', 'neutral', 'mixed'] as const;

const categoryItemSchema = z.object({ id: z.string() }).passthrough();

interface VocChatContext {
  systemPrompt: string;
  userMessage: string;
  metadata: {
    total_feedback: number;
    days_analyzed: number;
    urgent_count: number;
    filters: {
      source?: string;
      category?: string;
      sentiment?: string;
      days: number;
      dateBasis?: 'imported' | 'review';
    };
  };
}

function parseContextFilters(contextHint: string): Record<string, string> {
  const filters: Record<string, string> = {};
  const patterns: Record<string, RegExp> = {
    source: /Source:\s*([^.]+)/,
    category: /Category:\s*([^.]+)/,
    sentiment: /Sentiment:\s*([^.]+)/,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = pattern.exec(contextHint);
    if (match?.[1]) filters[key] = match[1].trim();
  }
  return filters;
}

async function sumDailyMetric(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  metricKey: string,
  days: number,
): Promise<number> {
  const now = new Date();
  const totals = await Promise.all(
    Array.from({ length: days }, (_, i) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      return d.toISOString().slice(0, 10);
    }).map(async (dateStr) => {
      try {
        const resp = await docClient.send(
          new QueryCommand({
            TableName: aggregatesTable,
            KeyConditionExpression: 'pk = :pk AND sk = :sk',
            ExpressionAttributeValues: { ':pk': metricKey, ':sk': dateStr },
          }),
        );
        const items = resp.Items ?? [];
        return items.length > 0 ? Number(items[0].count ?? items[0].value ?? 0) : 0;
      } catch {
        return 0;
      }
    }),
  );
  return totals.reduce((sum, v) => sum + v, 0);
}

async function getConfiguredCategories(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
): Promise<string[]> {
  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: aggregatesTable,
        KeyConditionExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: { ':pk': 'CONFIG#categories', ':sk': 'CURRENT' },
      }),
    );
    const items = resp.Items ?? [];
    if (items.length > 0) {
      const firstItem: Record<string, unknown> = items[0];
      const cats = firstItem.categories;
      if (Array.isArray(cats)) {
        return cats
          .map((c: unknown) => {
            const parsed = categoryItemSchema.safeParse(c);
            return parsed.success ? parsed.data.id : '';
          })
          .filter(Boolean);
      }
    }
  } catch {
    // fallback
  }
  return [];
}

function getLanguageInstruction(lang?: string): string {
  if (!lang || lang === 'en') return '';
  const names: Record<string, string> = {
    es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
    ja: 'Japanese', zh: 'Chinese', ko: 'Korean', it: 'Italian',
    nl: 'Dutch', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
    sv: 'Swedish', pl: 'Polish', tr: 'Turkish',
  };
  const name = names[lang] ?? lang;
  return `IMPORTANT: You MUST respond entirely in ${name} (${lang}). All text, headings, labels, and explanations must be in ${name}.`;
}

async function fetchCategoryCounts(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  days: number,
): Promise<[string, number][]> {
  const categories = await getConfiguredCategories(docClient, aggregatesTable);
  const counts: [string, number][] = [];
  for (const cat of categories) {
    const count = await sumDailyMetric(docClient, aggregatesTable, `METRIC#daily_category#${cat}`, days);
    if (count > 0) counts.push([cat, count]);
  }
  counts.sort((a, b) => b[1] - a[1]);
  return counts.slice(0, 5);
}

function buildSystemPrompt(responseLanguage?: string): string {
  const base = `You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.

You have access to two tools:
- "search_feedback": search and retrieve customer feedback from various sources (web scrapers, manual imports, S3 imports, etc.).
- "create_project": turn the insights from this conversation into a new project, pre-filling its product context.

IMPORTANT GUIDELINES:
1. ONLY use the search_feedback tool when the user's question is specifically about customer feedback, reviews, or customer opinions
2. For general questions, greetings, or non-feedback topics, respond directly WITHOUT using the tool
3. When you DO use the tool, be specific with your search query to get relevant results
4. For broad questions (summarize, count, trends, "top/most urgent/biggest issues"), call search_feedback with mode="aggregate" — it returns stats over the ENTIRE dataset in one call. Do NOT repeatedly page through individual items.
5. To find urgent/critical feedback, pass urgency="high" and/or sort_by="urgency". The query field is a literal substring match on review text, so words like "urgent" in the query will NOT filter by urgency level.
6. Base your answers on the actual data returned by the tool
7. Quote actual customer feedback when relevant
8. Highlight urgent issues that need attention
9. Provide actionable recommendations based on the data
10. When the user asks to turn findings into a project ("make/create a project", "프로젝트 만들어줘"), call create_project. First make sure you've analyzed the relevant feedback (search_feedback) so you can draft a grounded name, description, and product-context fields (product_name, one_liner, target_users, problem_solved, key_features). Only fill fields you can support with the actual feedback — omit the rest rather than inventing.

Format your responses clearly with bullet points or numbered lists when appropriate.`;

  const langInstruction = getLanguageInstruction(responseLanguage);
  return langInstruction ? `${base}\n\n${langInstruction}` : base;
}

function buildDataContext(
  days: number,
  totalFeedback: number,
  urgentCount: number,
  sentimentMap: Record<string, number>,
  topCategories: [string, number][],
  sourceFilter?: string,
  categoryFilter?: string,
  sentimentFilter?: string,
): string {
  const pct = (n: number) => ((n / Math.max(totalFeedback, 1)) * 100).toFixed(1);
  const topCatLines = topCategories.map(([cat, count]) => `- ${cat}: ${count}`).join('\n');

  const context = `## Current Data Summary (Last ${days} days)

**Total Feedback Items:** ${totalFeedback}
**Urgent Issues:** ${urgentCount}

**Sentiment Breakdown:**
- Positive: ${sentimentMap.positive} (${pct(sentimentMap.positive)}%)
- Neutral: ${sentimentMap.neutral} (${pct(sentimentMap.neutral)}%)
- Negative: ${sentimentMap.negative} (${pct(sentimentMap.negative)}%)
- Mixed: ${sentimentMap.mixed} (${pct(sentimentMap.mixed)}%)

**Top Categories:**
${topCatLines}
`;

  const activeFilters: string[] = [];
  if (sourceFilter) activeFilters.push(`Source: ${sourceFilter}`);
  if (categoryFilter) activeFilters.push(`Category: ${categoryFilter}`);
  if (sentimentFilter) activeFilters.push(`Sentiment: ${sentimentFilter}`);
  if (activeFilters.length > 0) {
    return `${context}\n## Active Filters: ${activeFilters.join(', ')}\nWhen using the search_feedback tool, apply these filters.\n`;
  }
  return context;
}

export async function buildVocChatContext(
  docClient: DynamoDBDocumentClient,
  aggregatesTable: string,
  body: {
    message: string;
    context?: string;
    days?: number;
    date_basis?: 'imported' | 'review';
    response_language?: string;
  },
): Promise<VocChatContext> {
  const message = body.message;
  const contextHint = body.context ?? '';
  const days = Math.min(Math.max(body.days ?? 7, 1), 365);

  const parsed = parseContextFilters(contextHint);
  const sourceFilter = parsed.source;
  const categoryFilter = parsed.category;
  const sentimentFilter = parsed.sentiment;

  // Fetch metrics in parallel
  const [totalFeedback, urgentCount, ...sentimentCounts] = await Promise.all([
    sumDailyMetric(docClient, aggregatesTable, 'METRIC#daily_total', days),
    sumDailyMetric(docClient, aggregatesTable, 'METRIC#urgent', days),
    ...SENTIMENT_LABELS.map((s) =>
      sumDailyMetric(docClient, aggregatesTable, `METRIC#daily_sentiment#${s}`, days),
    ),
  ]);

  const sentimentMap: Record<string, number> = {};
  for (const [i, label] of SENTIMENT_LABELS.entries()) {
    sentimentMap[label] = sentimentCounts[i];
  }

  const topCategories = await fetchCategoryCounts(docClient, aggregatesTable, days);

  const systemPrompt = buildSystemPrompt(body.response_language);
  const dataContext = buildDataContext(
    days, totalFeedback, urgentCount, sentimentMap, topCategories,
    sourceFilter, categoryFilter, sentimentFilter,
  );
  const userMessage = `${dataContext}\n\n---\n\nUser Question: ${message}`;

  return {
    systemPrompt,
    userMessage,
    metadata: {
      total_feedback: totalFeedback,
      days_analyzed: days,
      urgent_count: urgentCount,
      filters: {
        source: sourceFilter,
        category: categoryFilter,
        sentiment: sentimentFilter,
        days,
        // Rides through to the search tool; the aggregate headline numbers
        // above stay import-bucketed (they come from daily aggregates).
        dateBasis: body.date_basis,
      },
    },
  };
}
