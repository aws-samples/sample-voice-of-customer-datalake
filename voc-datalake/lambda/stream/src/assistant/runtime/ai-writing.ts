/**
 * The caller's way of working with AI (docs/ways-of-working.md), read once per run.
 *
 * Stored by the users Lambda in the aggregates table, `USERFLAGS#{sub}` / `ai_mode`
 * (`lambda/shared/ai_mode.py`): `{mode, ai_writing_prfaq, ai_writing_prd}`. No row =
 * `ai_driven` (today's behaviour). The run uses it to:
 *   - drop `generate_document` when the AI may write neither a PR/FAQ nor a PRD;
 *   - refuse, before any card, a PR/FAQ / PRD write the policy forbids
 *     (tools/ai-writing-guard.ts), and a plan that would have one written autonomously;
 *   - add the coaching section to the system prompt.
 *
 * The REST routes enforce the same rules (`lambda/shared/ai_writing.py`); this is the
 * conversation-side half, and the only guard on an assistant `update_document` card
 * (the SPA executes it with the person's token, which the API cannot tell from typing).
 *
 * Fails CLOSED: an unreadable or slow row reads as Human-driven with nothing unlocked
 * (the most coaching, no AI writing), never as AI-driven.
 */
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ConfigurationError } from '../../lib/errors.js';
import { failOpen } from './fail-open.js';

const AI_MODES = ['human_driven', 'ai_assisted', 'ai_driven'] as const;
type AiMode = (typeof AI_MODES)[number];
export const GATED_DOC_TYPES = ['prfaq', 'prd'] as const;
type GatedDocType = (typeof GATED_DOC_TYPES)[number];

export interface AiWritingPolicy {
  mode: AiMode;
  /** Doc types the AI may draft or rewrite WITH the person (editor, chat cards). */
  interactive: ReadonlySet<GatedDocType>;
  /** Agents and approved plans may write PR/FAQs and PRDs for the person (AI-driven only). */
  autonomous: boolean;
}

export type LoadAiWritingPolicy = (sub: string) => Promise<AiWritingPolicy>;

const ALL_TYPES: ReadonlySet<GatedDocType> = new Set(GATED_DOC_TYPES);
const AI_DRIVEN_POLICY: AiWritingPolicy = { mode: 'ai_driven', interactive: ALL_TYPES, autonomous: true };
/** The fail-closed answer: Human-driven, nothing unlocked. */
const LOCKED_POLICY: AiWritingPolicy = { mode: 'human_driven', interactive: new Set(), autonomous: false };

/** An unlock reads as locked unless it is literally `true`. */
const unlockFlag = z.boolean().catch(false);
const rowSchema = z.object({ mode: z.enum(AI_MODES).catch('ai_driven'), ai_writing_prd: unlockFlag, ai_writing_prfaq: unlockFlag }).loose();

/** The policy a stored row describes. */
function policyFromRow(row: unknown): AiWritingPolicy {
  if (row === undefined) return AI_DRIVEN_POLICY;
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) return AI_DRIVEN_POLICY;
  const { mode, ai_writing_prfaq: prfaq, ai_writing_prd: prd } = parsed.data;
  if (mode === 'ai_driven') return AI_DRIVEN_POLICY;
  if (mode === 'ai_assisted') return { mode, interactive: ALL_TYPES, autonomous: false };
  const unlocked = new Set<GatedDocType>();
  if (prfaq) unlocked.add('prfaq');
  if (prd) unlocked.add('prd');
  return { mode, interactive: unlocked, autonomous: false };
}

/** The production loader: one strongly consistent GetItem on the caller's own row. */
export function createAiWritingLoader(docClient: DynamoDBDocumentClient, tableName: string): LoadAiWritingPolicy {
  return async (sub) => {
    if (!tableName) throw new ConfigurationError('AGGREGATES_TABLE is not configured');
    const out = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `USERFLAGS#${sub}`, sk: 'ai_mode' },
      ConsistentRead: true,
    }));
    return policyFromRow(out.Item);
  };
}

const POLICY_TIMEOUT_MS = 2500;

/** This run's policy; AI-driven without a loader (tests), locked when the read fails or is slow. */
export async function aiWritingForRun(
  load: LoadAiWritingPolicy | undefined,
  sub: string,
  timeoutMs: number = POLICY_TIMEOUT_MS,
): Promise<AiWritingPolicy> {
  if (load === undefined) return AI_DRIVEN_POLICY;
  return failOpen(() => load(sub), LOCKED_POLICY, timeoutMs, 'Way of working unknown; AI writing locked');
}

/** True when the AI may write `docType` interactively for this person (other types: always). */
export function mayWriteInteractively(policy: AiWritingPolicy | undefined, docType: unknown): boolean {
  if (policy === undefined || !isGatedDocType(docType)) return true;
  return policy.interactive.has(docType);
}

export function isGatedDocType(value: unknown): value is GatedDocType {
  return value === 'prfaq' || value === 'prd';
}

const LABELS: Record<GatedDocType, string> = { prfaq: 'PR/FAQ', prd: 'PRD' };

export function docTypeLabel(docType: GatedDocType): string {
  return LABELS[docType];
}

/** The coaching section of the dynamic system prompt ([] when the AI may write everything). */
export function aiWritingPromptLines(policy: AiWritingPolicy | undefined): string[] {
  if (policy === undefined || policy.mode === 'ai_driven') return [];
  const locked = GATED_DOC_TYPES.filter((t) => !policy.interactive.has(t)).map(docTypeLabel);
  const lines = ['## Way of working with AI'];
  if (locked.length > 0) {
    const names = locked.join(' and ');
    lines.push(
      `The user works Human-driven on ${names}: they write it, you coach. For any ${names} you may answer questions `
      + '(also questions outside the document), explain the Working Backwards method and what a good section contains, '
      + 'ask the questions a reviewer would ask, and review their draft: quote their own words, say what works and '
      + 'what is missing, and back it with feedback evidence. Never draft, rewrite, complete or produce paste-ready '
      + `${names} text: no example headlines, FAQ answers, requirements or sample paragraphs they could copy. `
      + 'If they ask you to write it, decline kindly in one sentence and coach instead: ask what they would say, '
      + 'then give feedback on it. An administrator can unlock writing with AI for them. Other documents are not '
      + 'restricted.',
    );
  }
  lines.push('Agents and approved plans may not write a PR/FAQ or PRD for this user: never propose a plan step that '
    + 'generates, merges into or edits one.');
  return lines;
}
