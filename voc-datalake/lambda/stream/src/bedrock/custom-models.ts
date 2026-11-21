/**
 * The deployment's own models in the stream Lambda (7.65.00, docs/deployment.md "Bring your own model").
 *
 * The registry arrives as `CUSTOM_MODELS`, the JSON the synth checked and wrote (lib/utils/custom-models.ts), on the
 * Lambdas of the stacks that grant the models. MIRRORS lambda/shared/custom_models.py; the Python lockstep test
 * (lambda/shared/test/test_custom_models_lockstep.py) reads this file's constants, and the three readers share one
 * fixture (lib/test-support/custom-models-env.json).
 *
 * The stream runs a custom model only on a surface it declares and only with `capabilities.tools` (the assistant
 * and the plan steps send tools; the synth refuses chat and agent_worker without them). Its requests carry no
 * `thinking` field (model-override.ts takesThinkingBudget), `maxTokens` at most its `maxOutputTokens`, and no
 * document or image block unless it reads them (model-fallback.ts chatModelForAttachments; the Library sends text).
 * Its `contextWindow` sizes the replayed history (history-budget.ts `historyBudgetFor`). The `json` capability is not
 * read here: JSON answers are the enrichment and utility surfaces', never a stream surface, and the synth refuses a
 * model that serves them without it (lib/utils/custom-models.ts), as it refuses chat without tools.
 * Read leniently: an entry this module cannot read is skipped and logged, never thrown.
 */
import { z } from 'zod';

export const CUSTOM_MODELS_ENV = 'CUSTOM_MODELS';
/** At most this many are read (the synth refuses more). */
export const MAX_CUSTOM_MODELS = 4;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** A model's input window when its entry names none (lib/utils/custom-models.ts DEFAULT_CONTEXT_WINDOW). */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

const CustomModelSchema = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
  label: z.string().min(1),
  surfaces: z.array(z.string()).min(1),
  capabilities: z.object({ tools: z.boolean(), documents: z.boolean(), json: z.boolean(), temperature: z.boolean() }),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
});

/** One registry entry, as the stream uses it. */
export interface StreamCustomModel {
  readonly id: string;
  readonly surfaces: readonly string[];
  readonly tools: boolean;
  readonly documents: boolean;
  readonly maxOutputTokens: number;
  /** Its input window, in tokens. */
  readonly contextWindow: number;
}

const parsed = new Map<string, readonly StreamCustomModel[]>();

/** The env value as JSON, or [] (logged) when it is not JSON. */
function jsonOf(raw: string): unknown {
  if (raw.trim() === '') return [];
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`${CUSTOM_MODELS_ENV} is not valid JSON; no custom model is offered`);
    return [];
  }
}

function parseRegistry(raw: string): readonly StreamCustomModel[] {
  const entries = jsonOf(raw);
  if (!Array.isArray(entries)) return [];
  const models: StreamCustomModel[] = [];
  for (const [index, entry] of entries.slice(0, MAX_CUSTOM_MODELS).entries()) {
    const result = CustomModelSchema.safeParse(entry);
    if (!result.success || models.some((model) => model.id === result.data.id)) {
      console.warn(`${CUSTOM_MODELS_ENV} entry ${String(index + 1)} skipped: it cannot be read or repeats an id`);
      continue;
    }
    // (the key and the label are the registry's, for the SPA and the logs; the stream reads neither)
    const { id, surfaces, capabilities, maxOutputTokens, contextWindow } = result.data;
    models.push({
      id, surfaces, tools: capabilities.tools, documents: capabilities.documents,
      maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    });
  }
  return models;
}

/** The deployment's custom models (none without `CUSTOM_MODELS`), parsed once per value. */
export function customModels(raw: string = process.env[CUSTOM_MODELS_ENV] ?? ''): readonly StreamCustomModel[] {
  const known = parsed.get(raw);
  if (known !== undefined) return known;
  const models = parseRegistry(raw);
  parsed.set(raw, models);
  return models;
}

/** The custom model whose id is `modelId` (custom ids are sent as they are: never scope-mapped). */
export function customModel(modelId: unknown): StreamCustomModel | undefined {
  return customModels().find((model) => model.id === modelId);
}

/** `value` when it names a custom model the stream may run for `surface` (declared, with tools), else undefined. */
export function streamCustomModel(value: unknown, surface: string): string | undefined {
  const model = customModel(value);
  return model !== undefined && model.tools && model.surfaces.includes(surface) ? model.id : undefined;
}

/** A custom model's input window in tokens; undefined for any other model (Claude's windows hold the defaults). */
export function customContextWindow(modelId: string): number | undefined {
  return customModel(modelId)?.contextWindow;
}

/** `maxTokens`, at most a custom model's `maxOutputTokens`. */
export function capOutputTokens(modelId: string, maxTokens: number): number {
  const model = customModel(modelId);
  return model === undefined ? maxTokens : Math.min(maxTokens, model.maxOutputTokens);
}

/** False for a custom model that reads no document or image block; true for any other model. */
export function readsAttachments(modelId: string): boolean {
  return customModel(modelId)?.documents ?? true;
}
