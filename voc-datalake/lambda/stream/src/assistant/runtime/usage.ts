/**
 * Bedrock token usage → AG-UI `TokenUsage`.
 *
 * Bedrock reports cache reads and writes SEPARATELY from `inputTokens`, while
 * AG-UI defines `cachedInputTokens` / `cacheWriteInputTokens` as PARTS of
 * `inputTokens`. The total input is therefore the sum of the three.
 * Usage is summed across every Bedrock turn of the run.
 */
import type { TokenUsage as BedrockUsage } from '@aws-sdk/client-bedrock-runtime';
import type { TokenUsage } from '@ag-ui/core';

export interface UsageTotals {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  turns: number;
}

export function emptyUsage(): UsageTotals {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 };
}

export function addUsage(totals: UsageTotals, usage: BedrockUsage | null): UsageTotals {
  if (!usage) return totals;
  return {
    uncachedInput: totals.uncachedInput + (usage.inputTokens ?? 0),
    cacheRead: totals.cacheRead + (usage.cacheReadInputTokens ?? 0),
    cacheWrite: totals.cacheWrite + (usage.cacheWriteInputTokens ?? 0),
    output: totals.output + (usage.outputTokens ?? 0),
    turns: totals.turns + 1,
  };
}

export function toAguiUsage(totals: UsageTotals, modelId: string): TokenUsage[] {
  if (totals.turns === 0) return [];
  const inputTokens = totals.uncachedInput + totals.cacheRead + totals.cacheWrite;
  return [{
    ...(modelId.includes('anthropic') ? { provider: 'anthropic' } : {}),
    model: modelId,
    inputTokens,
    outputTokens: totals.output,
    totalTokens: inputTokens + totals.output,
    cachedInputTokens: totals.cacheRead,
    cacheWriteInputTokens: totals.cacheWrite,
  }];
}

/** Numbers only — never content. */
export function logUsage(totals: UsageTotals, modelId: string): void {
  console.log(JSON.stringify({
    event: 'assistant_usage',
    model: modelId,
    turns: totals.turns,
    inputTokens: totals.uncachedInput,
    cacheReadInputTokens: totals.cacheRead,
    cacheWriteInputTokens: totals.cacheWrite,
    outputTokens: totals.output,
  }));
}
