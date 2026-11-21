/**
 * The deployment's own models (7.65.00, docs/deployment.md "Bring your own model (-c customModels)"): Bedrock
 * models, inference profiles or Custom Model Import models the deployment's owner approved, added to the AI
 * surfaces' picker beside the Claude allowlist (model-allowlist.ts), never instead of it.
 *
 *   -c customModels='[{"key","id","label","kind":"bedrock|imported","surfaces":[...],"eu":bool,
 *                      "capabilities":{"tools","documents","json","temperature"},"price":{"in","out"}}]'
 *
 * Off by default: no key (or `[]`) changes no template. Everything below is checked at synth, so a registry the
 * runtime could not honour never deploys:
 *  - the id's shape by kind: a Bedrock model id or system inference-profile id (`bedrock`), or an imported-model ARN
 *    in the deployment's own account and Region (`imported`); provisioned throughput, fine-tuned custom models and
 *    application inference profiles are refused (a fixed cost, or a model the grant cannot name);
 *  - residency: `-c inferenceScope=eu` needs `eu: true` on every model, and `eu: true` needs an `eu.` profile or an
 *    in-Region model in an EU Region; a `global.` profile is refused under eu, and a model in another Region is
 *    refused outright (an imported model's ARN names the app Region; another geographic profile, such as `us.`,
 *    declares its destination Regions in `regions`, which must include the app Region);
 *  - a price (USD per million input and output tokens): the cost rollup and the cost page price the model's tokens
 *    with it (lambda/shared/model_prices.py), so a custom model is never an unpriced line (TENETS.md tenet 6);
 *  - the surfaces: every picker surface but the web search one's (its own GPT family), and never the engineering
 *    harness, the avatars or the embeddings, which are no picker surfaces; a surface whose callers use tools
 *    (`chat`, `agent_worker`) needs `capabilities.tools`, one whose answers are parsed as JSON needs `json`.
 *
 * The grant: claude-model-grant.ts adds each model's exact ARNs to the stack's shared model policies (no wildcard,
 * no Region wildcard), and only the engineering runtime's roles keep a Claude-only twin. The runtime reads the
 * registry from `CUSTOM_MODELS`, which {@link applyCustomModelsEnv} sets on exactly the Lambdas whose role holds that
 * grant, plus the few that read it without calling a model ({@link readsCustomModelRegistry}): so a function that
 * reads a custom model can always invoke it, and no other function's 4 KB environment grows. Readers:
 * lambda/shared/custom_models.py and the stream Lambda's custom-models.ts.
 * The Python lockstep test (lambda/shared/test/test_custom_models_lockstep.py) reads this file's lists.
 */
import * as cdk from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';
import { z } from 'zod';

import { type InferenceScope, inferenceScopeOf } from './inference-scope';
import { ALLOWED_MODEL_IDS, type ClaudeModelArns, EU_PROFILE_DESTINATION_REGIONS, partitionOf, toFoundationModelId } from './model-allowlist';
import { WEB_SEARCH_MODELS } from './web-search-models';

const CUSTOM_MODELS_CONTEXT_KEY = 'customModels';
/** The Lambda environment variable that carries the checked registry (JSON). */
export const CUSTOM_MODELS_ENV = 'CUSTOM_MODELS';
/** At most this many: each adds ARNs to the shared model policies (6,144 characters each) and to every Lambda env. */
export const MAX_CUSTOM_MODELS = 4;
/** The surfaces a custom model may serve: every picker surface but `web_reviews_search`. */
const CUSTOM_MODEL_SURFACES = [
  'chat', 'documents', 'prototype', 'enrichment', 'utility', 'memory',
  'agent_orchestrator', 'agent_worker', 'agent_reviewer', 'agent_persona',
] as const;
/** Surfaces whose callers send tools: the assistant (stream) and the plan steps (`agent_worker`, voc-plan-step). */
const TOOL_SURFACES: readonly string[] = ['chat', 'agent_worker'];
/** Surfaces whose callers parse the answer as JSON (enrichment, memory, personas, the crews' steps, …). */
const JSON_SURFACES: readonly string[] = [
  'documents', 'enrichment', 'utility', 'memory', 'agent_orchestrator', 'agent_worker', 'agent_reviewer', 'agent_persona',
];
/** Assumed when the registry names none: small enough for most models (an over-estimate is a hard 400). */
export const DEFAULT_CONTEXT_WINDOW = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/**
 * The smallest window a model serving `documents` may declare: below it the feedback a PR/FAQ, a PRD, a persona set or
 * a research run is written from holds fewer than seven reviews (lambda/shared/feedback.py `feedback_char_budget`
 * reserves half of a small window, then fills half of the rest).
 */
const MIN_DOCUMENTS_CONTEXT_WINDOW = 16_000;
/**
 * The env value's ceiling. A Lambda's whole environment is 4 KB (keys and values); the largest that carries the
 * registry is the logs API's, 2,434 characters deployed (measured 2026-11-21 with `aws lambda
 * get-function-configuration` on a 7.5x deployment), so 1,200 more keeps it under 3,700.
 */
export const MAX_ENV_CHARS = 1_200;
/** A system inference profile's prefix, by its geography; anything else before the first dot is a provider. */
const GEO_PREFIXES = ['global', 'eu', 'us', 'us-gov', 'apac', 'jp', 'au', 'ca'] as const;
const REGION_NAME = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const BEDROCK_ID = /^(?:[a-z-]+\.)?[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.:_-]*$/;
const IMPORTED_ARN = /^arn:([a-z-]+):bedrock:([a-z0-9-]+):(\d{12}):imported-model\/([a-z0-9]{1,64})$/;
/** Ids that can never be a pay-per-use model this grant can name. */
const REFUSED_IDS: readonly (readonly [RegExp, string])[] = [
  [/provisioned-model/, 'provisioned throughput is refused: it is a fixed cost (TENETS.md tenet 7)'],
  [/:custom-model(?:-deployment)?\//, 'a fine-tuned custom model runs on provisioned throughput or a deployment; not supported'],
  [/application-inference-profile\//, 'an application inference profile hides its model from the grant; name the model or system profile'],
];

const EntrySchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9]{1,23}$/, 'a lower-case letter, then 1 to 23 lower-case letters or digits'),
  id: z.string().min(3).max(200),
  label: z.string().trim().min(1).max(60),
  kind: z.enum(['bedrock', 'imported']),
  surfaces: z.array(z.enum(CUSTOM_MODEL_SURFACES)).min(1),
  eu: z.boolean(),
  capabilities: z.strictObject({ tools: z.boolean(), documents: z.boolean(), json: z.boolean(), temperature: z.boolean() }),
  price: z.strictObject({ in: z.number().nonnegative().max(1_000), out: z.number().nonnegative().max(1_000) }),
  regions: z.array(z.string().regex(REGION_NAME, 'an AWS Region name')).min(1).max(8).optional(),
  contextWindow: z.number().int().min(1_000).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
});
type Entry = z.infer<typeof EntrySchema>;

/** Where the model is served from: an in-Region Bedrock model, a system inference profile, or Custom Model Import. */
type CustomModelSource = 'model' | 'profile' | 'imported';

/** One checked registry entry (what the runtime reads from {@link CUSTOM_MODELS_ENV}, {@link customModelsEnvValue}). */
export interface CustomModel {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly kind: Entry['kind'];
  readonly source: CustomModelSource;
  readonly surfaces: readonly string[];
  readonly eu: boolean;
  /** The Regions its inference may run in; empty = any commercial Region (a `global.` profile). */
  readonly regions: readonly string[];
  readonly capabilities: Entry['capabilities'];
  readonly price: Entry['price'];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/** Where a synth runs: the stack's Region and account, and the app's inference scope. */
export interface RegistryTarget {
  readonly region: string;
  readonly account: string;
  readonly scope: InferenceScope;
}

function fail(where: string, reason: string): never {
  throw new Error(`-c ${CUSTOM_MODELS_CONTEXT_KEY}: ${where}: ${reason}. See docs/deployment.md, "Bring your own model".`);
}

/** The raw context value as a list: absent, '', '[]' and [] are none; a string is JSON. */
function rawEntries(raw: unknown): unknown[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      fail('the value', 'not valid JSON (quote the list for your shell)');
    }
  }
  if (!Array.isArray(value)) fail('the value', 'a JSON list of models');
  return value;
}

function geoPrefix(id: string): (typeof GEO_PREFIXES)[number] | undefined {
  const head = id.split('.')[0];
  return GEO_PREFIXES.find((prefix) => prefix === head);
}

/** An imported model's ARN: in the app Region, the deployment's account and the Region's partition. */
function checkImportedArn(id: string, where: string, target: RegistryTarget): void {
  const match = IMPORTED_ARN.exec(id);
  if (match === null) fail(where, 'an imported model is named by its ARN, arn:<partition>:bedrock:<region>:<account>:imported-model/<id>');
  const [, partition, region, account] = match;
  if (region !== target.region) fail(where, `the imported model is in ${region}, not the app Region ${target.region}: a model in another Region is refused`);
  if (!cdk.Token.isUnresolved(target.account) && account !== target.account) fail(where, `the imported model belongs to account ${account}, not the deployment's`);
  if (partition !== partitionOf(target.region)) fail(where, `partition ${partition} is not the app Region's`);
}

/** The id's source, after the shape checks of its kind (refused shapes throw). */
function sourceOf(entry: Entry, where: string, target: RegistryTarget): CustomModelSource {
  for (const [pattern, reason] of REFUSED_IDS) if (pattern.test(entry.id)) fail(where, reason);
  if (entry.kind === 'imported') {
    checkImportedArn(entry.id, where, target);
    return 'imported';
  }
  if (!BEDROCK_ID.test(entry.id)) fail(where, 'a bedrock model is named by its model id or system inference-profile id (no ARN)');
  return geoPrefix(entry.id) === undefined ? 'model' : 'profile';
}

/** A profile's Regions by its prefix: none for `global.` (any Region), the EU table for `eu.`, else the declared ones. */
function profileRegions(prefix: (typeof GEO_PREFIXES)[number], entry: Entry, where: string, target: RegistryTarget): readonly string[] {
  if (target.scope === 'eu' && prefix !== 'eu') fail(where, `a ${prefix}. profile is refused under -c inferenceScope=eu (requests may leave the EU)`);
  if (prefix === 'global') return [];
  if (prefix === 'eu') {
    const destinations = EU_PROFILE_DESTINATION_REGIONS[target.region];
    if (destinations === undefined) fail(where, `an eu. profile needs the app in an EU source Region, not ${target.region}`);
    // (a model's own eu. profile may route to other EU Regions than Claude's table: its `regions`, EU ones only)
    if (entry.regions === undefined) return destinations;
    if (!entry.regions.every((region) => region.startsWith('eu-'))) fail(where, 'an eu. profile\'s `regions` are EU Regions only');
    if (!entry.regions.includes(target.region)) fail(where, `\`regions\` must include the app Region ${target.region}`);
    return [...new Set(entry.regions)];
  }
  if (entry.regions === undefined) fail(where, `declare the ${prefix}. profile's destination Regions in \`regions\` (aws bedrock get-inference-profile)`);
  if (!entry.regions.includes(target.region)) fail(where, `\`regions\` must include the app Region ${target.region}`);
  return [...new Set(entry.regions)];
}

/** The Regions the model's inference may run in (throws when the scope or the residency claim forbids them). */
function regionsOf(entry: Entry, source: CustomModelSource, where: string, target: RegistryTarget): readonly string[] {
  const prefix = source === 'profile' ? geoPrefix(entry.id) : undefined;
  if (entry.regions !== undefined && (prefix === undefined || prefix === 'global')) {
    fail(where, '`regions` is only for a geographic profile (eu., us. …), never a global. one or a model in the Region');
  }
  const regions = prefix === undefined ? [target.region] : profileRegions(prefix, entry, where, target);
  if (target.scope === 'eu' && !entry.eu) fail(where, '-c inferenceScope=eu needs `"eu": true` on every custom model');
  const inEu = regions.length > 0 && regions.every((region) => region.startsWith('eu-'));
  if (entry.eu && !inEu) fail(where, '`"eu": true` needs an eu. profile, or an in-Region or imported model in an EU Region');
  return regions;
}

function checkCapabilities(entry: Entry, where: string): void {
  const needs = (surfaces: readonly string[]) => entry.surfaces.filter((surface) => surfaces.includes(surface));
  const tools = needs(TOOL_SURFACES);
  if (tools.length > 0 && !entry.capabilities.tools) fail(where, `${tools.join(', ')} call tools: needs capabilities.tools`);
  const json = needs(JSON_SURFACES);
  if (json.length > 0 && !entry.capabilities.json) fail(where, `${json.join(', ')} parse JSON answers: needs capabilities.json`);
  if (new Set(entry.surfaces).size !== entry.surfaces.length) fail(where, 'a surface is listed twice');
  const window = entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if ((entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) > window) fail(where, 'maxOutputTokens is larger than contextWindow');
  if (entry.surfaces.includes('documents') && window < MIN_DOCUMENTS_CONTEXT_WINDOW) {
    fail(where, `documents needs a contextWindow of at least ${String(MIN_DOCUMENTS_CONTEXT_WINDOW)}: a smaller one holds too few reviews to write from`);
  }
}

/** The ids no custom model may take: the Claude allowlist (and its eu. and foundation twins) and the GPT models. */
function takenIds(): ReadonlySet<string> {
  return new Set([
    ...ALLOWED_MODEL_IDS, ...ALLOWED_MODEL_IDS.map(toFoundationModelId),
    ...ALLOWED_MODEL_IDS.map((id) => `eu.${toFoundationModelId(id)}`), ...WEB_SEARCH_MODELS,
  ]);
}

function checkedModel(raw: unknown, index: number, target: RegistryTarget): CustomModel {
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success) fail(`model ${index + 1}`, z.prettifyError(parsed.error).replaceAll('\n', '; '));
  const entry = parsed.data;
  const where = `model ${index + 1} (${entry.key})`;
  if (takenIds().has(entry.id)) fail(where, `${entry.id} is not a custom model: it is on the Claude or web search allowlist`);
  const source = sourceOf(entry, where, target);
  const regions = regionsOf(entry, source, where, target);
  checkCapabilities(entry, where);
  return {
    key: entry.key, id: entry.id, label: entry.label, kind: entry.kind, source, surfaces: [...entry.surfaces],
    eu: entry.eu, regions, capabilities: entry.capabilities, price: entry.price,
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/** The checked registry for `target` (throws with the first problem; an empty list when the key is unset). */
export function parseCustomModels(raw: unknown, target: RegistryTarget): readonly CustomModel[] {
  const entries = rawEntries(raw);
  if (entries.length > MAX_CUSTOM_MODELS) fail('the list', `at most ${MAX_CUSTOM_MODELS} models (got ${entries.length})`);
  const models = entries.map((entry, index) => checkedModel(entry, index, target));
  for (const field of ['key', 'id'] as const) {
    const values = models.map((model) => model[field]);
    const repeated = values.find((value, index) => values.indexOf(value) !== index);
    if (repeated !== undefined) fail('the list', `${field} ${repeated} is used twice`);
  }
  if (models.length > 0 && customModelsEnvValue(models).length > MAX_ENV_CHARS) {
    fail('the list', `too large for a Lambda environment (over ${MAX_ENV_CHARS} characters): shorten labels or list fewer models`);
  }
  return models;
}

/**
 * The {@link CUSTOM_MODELS_ENV} value: the checked registry as JSON, in the registry's order, without what the
 * readers derive (`kind`, implied by `source`; `contextWindow` and `maxOutputTokens` at their defaults).
 */
export function customModelsEnvValue(models: readonly CustomModel[]): string {
  return JSON.stringify(models.map((model) => ({
    key: model.key, id: model.id, label: model.label, source: model.source, surfaces: model.surfaces, eu: model.eu,
    regions: model.regions, capabilities: model.capabilities, price: model.price,
    ...(model.contextWindow === DEFAULT_CONTEXT_WINDOW ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === DEFAULT_MAX_OUTPUT_TOKENS ? {} : { maxOutputTokens: model.maxOutputTokens }),
  })));
}

const stackRegistries = new WeakMap<cdk.Stack, readonly CustomModel[]>();

/** The registry for the stack `scope` lives in (its Region and account, the app's scope), checked once per stack. */
export function stackCustomModels(scope: IConstruct): readonly CustomModel[] {
  const stack = cdk.Stack.of(scope);
  const known = stackRegistries.get(stack);
  if (known !== undefined) return known;
  const models = parseCustomModels(stack.node.tryGetContext(CUSTOM_MODELS_CONTEXT_KEY), {
    region: stack.region, account: stack.account, scope: inferenceScopeOf(stack),
  });
  stackRegistries.set(stack, models);
  return models;
}

/** One custom model's grant: a direct ARN (an in-Region or imported model), or the profile shape of model-allowlist.ts. */
export type CustomModelArns =
  | { readonly kind: 'direct'; readonly arn: string }
  | { readonly kind: 'profile'; readonly arns: ClaudeModelArns };

/** The exact ARNs `model` needs in `stack` (the profile's foundation model in each of its Regions, never `*`). */
export function customModelArns(model: CustomModel, stack: cdk.Stack): CustomModelArns {
  const { region, account } = stack;
  const partition = partitionOf(region);
  if (model.source === 'imported') {
    const resource = model.id.slice(model.id.indexOf(':imported-model/') + 1);
    return { kind: 'direct', arn: `arn:${partition}:bedrock:${region}:${account}:${resource}` };
  }
  if (model.source === 'model') return { kind: 'direct', arn: `arn:${partition}:bedrock:${region}::foundation-model/${model.id}` };
  const foundation = model.id.slice(model.id.indexOf('.') + 1);
  const profile = `arn:${partition}:bedrock:${region}:${account}:inference-profile/${model.id}`;
  if (model.regions.length === 0) {
    return { kind: 'profile', arns: {
      profile, regionalModels: [`arn:${partition}:bedrock:${region}::foundation-model/${foundation}`],
      globalModel: `arn:${partition}:bedrock:::foundation-model/${foundation}`, requestingRegion: region,
    } };
  }
  return { kind: 'profile', arns: { profile, regionalModels: model.regions.map((r) => `arn:${partition}:bedrock:${r}::foundation-model/${foundation}`) } };
}

/** Roles granted the custom models (claude-model-grant.ts), and functions that read the registry calling no model. */
const customModelRoles = new WeakSet<iam.IRole>();
const registryReaders = new WeakSet<lambda.IFunction>();

export function markCustomModelRole(role: iam.IRole): void {
  customModelRoles.add(role);
}

/** Give `fn` the registry though its role calls no model: the cost rollup prices with it, and System → Environment
 *  (the logs API) names a custom pick. */
export function readsCustomModelRegistry(fn: lambda.IFunction): void {
  registryReaders.add(fn);
}

/** Sets {@link CUSTOM_MODELS_ENV} on every function whose role holds the custom grant, and on the readers. */
class CustomModelsEnvAspect implements cdk.IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof lambda.Function)) return;
    const granted = node.role !== undefined && customModelRoles.has(node.role);
    if (!granted && !registryReaders.has(node)) return;
    const models = stackCustomModels(node);
    if (models.length > 0) node.addEnvironment(CUSTOM_MODELS_ENV, customModelsEnvValue(models));
  }
}

/** Give the registry to the Lambdas under `scope` that read it (app-aspects.ts; a no-op without `-c customModels`). */
export function applyCustomModelsEnv(scope: IConstruct): void {
  if (rawEntries(scope.node.tryGetContext(CUSTOM_MODELS_CONTEXT_KEY)).length === 0) return;
  cdk.Aspects.of(scope).add(new CustomModelsEnvAspect());
}
