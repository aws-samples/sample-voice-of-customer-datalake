/**
 * The text of a non-streamed Converse answer: what the plan-step model calls and
 * the persona consultation read back.
 */
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

/** The text blocks of a Converse answer, joined and trimmed ('' when it has none). */
export function answerText(output: ConverseCommandOutput): string {
  const content = output.output?.message?.content ?? [];
  return content.flatMap((block) => (typeof block.text === 'string' ? [block.text] : [])).join('').trim();
}
