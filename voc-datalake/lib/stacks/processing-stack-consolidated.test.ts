/**
 * Template-level tests for the research Step Functions wiring.
 *
 * Regression guard for issue #157: step_initialize's outputs only reach
 * later steps if InitializeResearch's resultSelector selects them AND the
 * consuming step's payload forwards them. documents_context was silently
 * dropped by the selector, so selected reference documents never reached
 * the analysis prompt. These tests fail if either half of the wiring is
 * removed again (e.g. in a conflict resolution on the selector block).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { stateMachineDefinition, synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { isRecord, itemAt, recordAt } from '../test-support/guards';
import { allowedActions, roleStatements } from '../test-support/iam-statements';
import { expectSelfInvokeOnly, findWorkerFunction } from '../test-support/worker-function';

function researchDefinition(template: Template): string {
  return stateMachineDefinition(template, 'ResearchStateMachine');
}

describe('research state machine wiring (issue #157)', () => {
  // Synthesized in beforeAll so a synth failure reports as a test failure
  // with a name, not a file-collection error.
  //
  // NOTE: the exact '"key.$":"path"' pins assume CDK's compact JSON
  // serialization of the definition (no whitespace around ':'). Stable
  // today; if a CDK upgrade ever pretty-prints definitions, all three
  // tests fail together — loosen to a whitespace-tolerant match then.
  const state: { definition: string } = { definition: '' };
  beforeAll(() => {
    state.definition = researchDefinition(synthProcessingTemplate());
  });

  it('selects documents_context out of the initialize result', () => {
    expect(state.definition).toContain('"documents_context.$":"$.Payload.documents_context"');
  });

  it('forwards documents_context into the analyze step payload', () => {
    expect(state.definition).toContain('"documents_context.$":"$.initialize_result.documents_context"');
  });

  it('keeps the sibling context selections intact', () => {
    // The same silent-drop failure mode applies to every initialize output
    // the analyze prompt consumes; pin the full set that must flow.
    for (const key of ['feedback_context', 'feedback_stats', 'personas_context', 'web_context']) {
      expect(state.definition).toContain(`"${key}.$":"$.Payload.${key}"`);
      expect(state.definition).toContain(`"${key}.$":"$.initialize_result.${key}"`);
    }
  });

  it('flows the executed web-search queries to the save step (#207)', () => {
    // step_initialize ALWAYS returns web_search_queries ([] when web search
    // is off); step_save consumes it for the report's disclosure section.
    expect(state.definition).toContain('"web_search_queries.$":"$.Payload.web_search_queries"');
    expect(state.definition).toContain('"web_search_queries.$":"$.initialize_result.web_search_queries"');
  });

  it('flows the derivation to the save step, so the report records its inputs', () => {
    // step_initialize is the only step that reads the reference documents,
    // personas and feedback; step_save is what writes the document. Drop
    // either half of this wiring and every research report silently loses the
    // answer to "what was this built from".
    expect(state.definition).toContain('"derivation.$":"$.Payload.derivation"');
    expect(state.definition).toContain('"derivation.$":"$.initialize_result.derivation"');
  });
});

/** Narrow a CloudFormation resource to its Properties without a bare cast. */
function propsOf(resource: unknown): Record<string, unknown> {
  return recordAt(resource, 'Properties') ?? {};
}

/**
 * Budgets are config-driven now, so they can be raised by editing a JSON file
 * while a mid-generation timeout discards the step. The function already runs at
 * Lambda's 15-minute hard maximum, so the only thing to guard is that nobody
 * lowers it. Memory matters too: Lambda scales CPU with it.
 */
describe('research Lambda keeps the maximum timeout its budgets assume', () => {
  const MAX_LAMBDA_TIMEOUT_SECONDS = 900;
  let researchFns: Record<string, unknown>[];

  beforeAll(() => {
    // Matched on the handler, not the construct id: a rename should not silently
    // skip these assertions. EVERY match is checked, so a second research
    // function cannot appear under the ceiling unnoticed.
    const fns = synthProcessingTemplate().findResources('AWS::Lambda::Function');
    researchFns = Object.values(fns)
      .map(propsOf)
      .filter((p) => typeof p.Handler === 'string' && p.Handler.includes('research_step_handler'));
  });

  it('finds the research Lambda (positive control for the loops below)', () => {
    expect(researchFns.length, 'no Lambda with the research_step_handler handler')
      .toBeGreaterThan(0);
  });

  it('runs at the maximum Lambda timeout', () => {
    for (const fn of researchFns) {
      expect(fn.Timeout).toBe(MAX_LAMBDA_TIMEOUT_SECONDS);
    }
  });

  it('has enough memory that generation is not CPU-starved', () => {
    // Lambda scales CPU with memory; a small function makes long generations
    // slower and therefore likelier to hit the ceiling above.
    for (const fn of researchFns) {
      expect(fn.MemorySize).toBeGreaterThanOrEqual(1024);
    }
  });
});

/**
 * research_step_handler reads its prompts and budgets from
 * api/prompts/research-analysis.json at RUNTIME. The first deploy of that change
 * shipped a bundle with no prompts/ at all — a FileNotFoundError the unit suite
 * could not see, because get_prompts_dir() resolves the repo layout locally
 * whether or not the bundle stages anything.
 *
 * Source assertions are a weak form (they break on reformatting and cannot prove
 * staging), used because bundling inputs appear in neither the template nor the
 * assets manifest. The behavioural half lives in
 * lambda/research/test/test_research_step_budgets.py.
 */
describe('research Lambda bundle stages its prompt config', () => {
  const source = readFileSync(join(__dirname, 'processing-stack-consolidated.ts'), 'utf-8');
  const researchAsset = source.split('const researchCode')[1]?.split('});')[0] ?? '';

  it('copies the prompts to the bundle root where get_prompts_dir looks first', () => {
    // THIS is the assertion that maps to the actual bug: a bundled asset mounts
    // the source dir as /asset-input, so the copy — not the exclude — is what puts
    // the config in the bundle. Verified empirically by reverting each half.
    expect(researchAsset).toContain('/asset-input/api/prompts /asset-output/prompts');
  });

  it('keeps api/prompts inside the asset fingerprint', () => {
    // Excluding api/ wholesale still bundles the prompts (the copy handles that),
    // but drops them from the hash — so editing research-analysis.json would not
    // redeploy the function and it would keep running the old budgets.
    expect(researchAsset).toContain("'!/api/prompts'");
    expect(researchAsset).not.toContain("'/api/',");
  });

  it('still excludes the sibling handler trees it does not ship', () => {
    // Re-including prompts must not become "stage everything", which would
    // redeploy this function on unrelated edits.
    for (const excluded of ["'/aggregator/'", "'/jobs/'", "'/processor/'"]) {
      expect(researchAsset).toContain(excluded);
    }
  });
});

describe('web-search wiring is skipped cleanly when the gateway is absent', () => {
  /**
   * Reachable combination since the AI-enablement stacks were merged: the stack
   * exists (for the Bedrock model-access half) while `deployWebSearch` is false,
   * so `webSearchGatewayUrl`/`Arn`/`ToolName` are undefined. This is also the
   * shape every `-c enableWebSearch=false` deployment produces.
   *
   * The guard at processing-stack-consolidated.ts:290 is what keeps that from
   * synthesizing an env var or an IAM statement containing the string
   * "undefined". These assertions fail if that guard is dropped or inverted.
   */
  const template = synthProcessingTemplate(); // helper omits the web-search props

  it('sets no WEB_SEARCH environment variables on the research Lambda', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    const webSearchVars = functions.flatMap((fn) => {
      const vars: unknown = fn.Properties?.Environment?.Variables;
      return vars && typeof vars === 'object'
        ? Object.keys(vars).filter((k) => k.startsWith('WEB_SEARCH'))
        : [];
    });
    expect(webSearchVars).toStrictEqual([]);
  });

  it('grants no bedrock-agentcore permissions', () => {
    // Scoped to IAM policy actions rather than a whole-template string match:
    // a blanket search would also fire on an unrelated future mention and give
    // a failure with no pointer to the guard it protects.
    const actions = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((policy) => policy.Properties?.PolicyDocument?.Statement ?? [])
      .flatMap((statement: { Action?: string | string[] }) =>
        typeof statement.Action === 'string' ? [statement.Action] : statement.Action ?? []);
    expect(actions.filter((a) => a.startsWith('bedrock-agentcore'))).toStrictEqual([]);
  });

  it('leaks no "undefined" into any Lambda environment value', () => {
    // The concrete failure mode if the guard were dropped: an absent gateway
    // URL/tool name stringified into an env var.
    const values = Object.values(template.findResources('AWS::Lambda::Function'))
      .flatMap((fn) => Object.values(fn.Properties?.Environment?.Variables ?? {}))
      .filter((v): v is string => typeof v === 'string');
    expect(values.filter((v) => v.includes('undefined'))).toStrictEqual([]);
  });
});

describe('the aggregator can reach the dedupe table it is already allowed to (#264)', () => {
  /**
   * DynamoDB Streams are at-least-once, and this Lambda's event source carries
   * `retryAttempts: 3` with `reportBatchItemFailures: true` — so a batch that
   * partially fails re-presents records whose counter updates already landed.
   * The handler closes that by claiming each record's `eventID` in the idempotency
   * table inside the same TransactWriteItems as the counters.
   *
   * The gap this pins was ENVIRONMENT ONLY: the shared `processingRole` has been
   * granted `idempotencyTable.grantReadWriteData` all along for the processor, so
   * the aggregator had the permission and not the NAME. That is exactly the shape
   * that degrades silently — `handler.py` reads `IDEMPOTENCY_TABLE` with a default
   * of empty and falls back to non-transactional writes with a warning, so a
   * regression here does not fail a deploy, does not error at runtime, and shows up
   * only as counters that drift under redelivery.
   */
  const template = synthProcessingTemplate();

  /** Every Lambda in this stack whose service name says it is the aggregator, found
   * by that name rather than by logical id: a CDK-generated id can change with a
   * construct-tree edit, and matching the function by what it IS keeps these tests
   * pinned to the function rather than to a name.
   *
   * Returns the ENVIRONMENTS rather than the resources, so the narrowing that proves
   * each one is an object happens once, here, where it is already being done — the
   * caller then needs no cast and the helper needs no `any`. */
  function aggregatorEnvironments(): Record<string, unknown>[] {
    return Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn) => recordAt(fn, 'Properties', 'Environment', 'Variables'))
      .filter((vars): vars is Record<string, unknown> => vars?.POWERTOOLS_SERVICE_NAME === 'voc-aggregator');
  }

  function aggregatorEnvironment(): Record<string, unknown> {
    const environments = aggregatorEnvironments();
    // ASSERTED HERE TOO, rather than only in the test below that owns the diagnosis.
    // Indexing [0] blind is what this replaced, and on zero matches that threw
    // `Cannot read properties of undefined` from each of the four tests — a TypeError
    // in a CDK assertion sends the reader looking for a template-shape problem when
    // the subject is simply gone. The duplication is cheap and this is the readable
    // failure; `finds exactly one aggregation Lambda` still reports it as its own
    // distinct problem.
    expect(environments).toHaveLength(1);
    return itemAt(environments, 0);
  }

  it('finds exactly one aggregation Lambda to assert about', () => {
    // THE DENOMINATOR, and it is its own test rather than a line inside the helper.
    // Zero matches would make every assertion below vacuously true and a second match
    // would mean they are no longer about one function — but asserted per call, that
    // showed up as a failure of whichever environment test happened to run first,
    // which reads as "the idempotency table name is missing" when what is really
    // wrong is that the subject is missing or ambiguous. Stated once, so the
    // diagnosis is one step shorter and names the real problem.
    expect(aggregatorEnvironments()).toHaveLength(1);
  });

  it('passes the idempotency table name to the aggregation Lambda', () => {
    expect(aggregatorEnvironment()).toHaveProperty('IDEMPOTENCY_TABLE');
  });

  it('names a real table rather than a literal, so the value resolves at deploy', () => {
    // A hand-written string would synthesize as a plain value and point at a table
    // that may not exist in this account. What a real table reference looks like is
    // NOT pinned to one spelling: the table is created in the core stack, so it
    // arrives here as an `Fn::ImportValue` today and would be a `Ref` if the two
    // were ever merged into one stack — both are CloudFormation resolving the table
    // this app created, and asserting the CloudFormation intrinsic rather than which
    // one keeps a stack reorganisation from failing a test whose subject it is not.
    const value = aggregatorEnvironment().IDEMPOTENCY_TABLE;
    expect(typeof value).toBe('object');
    expect(Object.keys(isRecord(value) ? value : {}).some((key) => key.startsWith('Fn::') || key === 'Ref'))
      .toBe(true);
  });

  it('names the SAME table the processor claims into', () => {
    // One table, two writers. Different tables would let a stream record and a
    // feedback record be deduped against separate state, which is not wrong so much
    // as unmeasurable — and it would silently double the tables an operator has to
    // know about. The handler namespaces its keys (`aggregator#stream#...`) so the
    // two cannot collide within it.
    const processor = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn) => recordAt(fn, 'Properties', 'Environment', 'Variables'))
      .find((vars) => vars?.POWERTOOLS_SERVICE_NAME === 'voc-processor');
    expect(processor).toBeDefined();
    expect(aggregatorEnvironment().IDEMPOTENCY_TABLE)
      .toStrictEqual(processor?.IDEMPOTENCY_TABLE);
  });

  it('keeps the aggregates table name too, so the transaction can name it', () => {
    // The counters go out as transaction items, which name their table by STRING
    // (`TableName`) rather than through the boto3 resource. So `AGGREGATES_TABLE`
    // stopped being merely how the handler finds its table and became what the
    // transaction is built from — losing it would break every write rather than
    // only the dedupe.
    expect(aggregatorEnvironment()).toHaveProperty('AGGREGATES_TABLE');
  });
});

/**
 * The category reprocess worker (POST /settings/categories/reprocess starts it):
 * re-categorises stored feedback IN PLACE, page by page, handing over to a fresh
 * async invocation of itself before its 15-minute ceiling. Least privilege is
 * the point of these cases — it must never be able to delete or replace a review.
 */
describe('category reprocess worker', () => {
  // Synthesized in beforeAll (not at collection time) so a synth failure is a
  // named test failure, like the research suite above.
  let template: Template;
  beforeAll(() => { template = synthProcessingTemplate(); });

  const worker = () => findWorkerFunction(template, 'voc-category-reprocess');

  const statements = () => roleStatements(template, worker().Role['Fn::GetAtt'][0]);
  const actionsOn = (prefix: string, fragment: string) => allowedActions(statements(), prefix, fragment);

  it('runs the category_reprocess handler with the 15-minute ceiling its hand-over assumes', () => {
    expect(worker().Handler).toBe('handler.lambda_handler');
    expect(worker().Timeout).toBe(900);
  });

  it('is handed the tables, the raw bucket and the primary language', () => {
    expect(Object.keys(worker().Environment.Variables)).toStrictEqual(expect.arrayContaining([
      'FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET', 'PRIMARY_LANGUAGE',
    ]));
  });

  it('holds exactly Scan/GetItem/UpdateItem on feedback — never Put or Delete', () => {
    expect(actionsOn('dynamodb:', 'Feedback')).toStrictEqual(['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
  });

  it('holds exactly GetItem/UpdateItem on aggregates — the worker never creates or lists jobs', () => {
    expect(actionsOn('dynamodb:', 'Aggregates'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
  });

  it('reads only raw/* in the raw bucket, and writes nothing there', () => {
    const s3 = statements().filter((s) => s.actions.some((a) => a.startsWith('s3:')));
    expect(s3.length).toBeGreaterThan(0);
    expect(s3.flatMap((s) => s.actions).filter((a) => /^s3:(Put|Delete|Abort)/.test(a))).toStrictEqual([]);
    const objectResources = s3.map((s) => s.resource).filter((r) => r.includes('/'));
    expect(objectResources.join(' ')).toContain('/raw/*');
    expect(objectResources.every((r) => !r.includes('"/*"')), 'bucket-wide object grant').toBe(true);
  });

  it('can call Bedrock, Comprehend and Translate', () => {
    const actions = statements().flatMap((s) => s.actions);
    expect(actions).toStrictEqual(expect.arrayContaining([
      'bedrock:InvokeModel', 'comprehend:DetectSentiment', 'comprehend:DetectDominantLanguage', 'translate:TranslateText',
    ]));
  });

  it('may invoke only itself, by an unqualified colon-form ARN', () => {
    expectSelfInvokeOnly(statements(), 'voc-category-reprocess-');
  });
});

describe('the aggregator stream source keeps what it gives up on (#253)', () => {
  const state: { template: Template | undefined } = { template: undefined };
  beforeAll(() => {
    state.template = synthProcessingTemplate();
  });
  const template = (): Template => {
    if (!state.template) throw new Error('template not synthesized');
    return state.template;
  };

  /** The mapping's Properties (records only — scalars are read off it directly). */
  const streamMappingProps = (): Record<string, unknown>[] => {
    const mappings = template().findResources('AWS::Lambda::EventSourceMapping');
    return Object.values(mappings)
      .map((m) => recordAt(m, 'Properties') ?? {})
      .filter((props) => props.StartingPosition === 'TRIM_HORIZON');
  };
  const failureQueueEntry = () => {
    const queues = template().findResources('AWS::SQS::Queue');
    return Object.entries(queues).find(([id]) => id.startsWith('AggregatorStreamFailures'));
  };

  it('has exactly one DynamoDB stream mapping', () => {
    expect(streamMappingProps()).toHaveLength(1);
  });

  it('sends exhausted batches to an SQS on-failure destination', () => {
    const props = itemAt(streamMappingProps(), 0);
    const onFailure = recordAt(props, 'DestinationConfig', 'OnFailure');
    expect(onFailure, 'DestinationConfig.OnFailure must be set').toBeDefined();
    const entry = failureQueueEntry();
    expect(entry).toBeDefined();
    expect(onFailure?.Destination).toStrictEqual({ 'Fn::GetAtt': [entry?.[0], 'Arn'] });
  });

  it('still bounds retries before giving up', () => {
    const props = itemAt(streamMappingProps(), 0);
    expect(props.MaximumRetryAttempts).toBe(3);
  });

  it('encrypts the failure queue with the app CMK', () => {
    const props = recordAt(failureQueueEntry()?.[1], 'Properties');
    expect(props?.KmsMasterKeyId).toBeDefined();
  });
});

describe('processor bundle ships the validation schema it imports (#249)', () => {
  const source = readFileSync(join(__dirname, 'processing-stack-consolidated.ts'), 'utf8');
  const processorAsset = source.split('const processorCode')[1]?.split('});')[0] ?? '';
  const lambdaRoot = join(__dirname, '..', '..', 'lambda');

  it('copies the processor handler and the shared tree', () => {
    expect(processorAsset).toContain('cp -r /asset-input/processor/* /asset-output/');
    expect(processorAsset).toContain('cp -r /asset-input/shared /asset-output/');
  });

  it('the schema lives in the shared tree that bundle copies', () => {
    expect(existsSync(join(lambdaRoot, 'shared', 'ingest_schemas.py'))).toBe(true);
  });

  it('the handler imports the schema from shared/, unconditionally', () => {
    const lines = readFileSync(join(lambdaRoot, 'processor', 'handler.py'), 'utf8').split('\n');
    const schemaImport = 'from shared.ingest_schemas import ';
    const importedNames = lines.filter((line) => line.startsWith(schemaImport))
      .flatMap((line) => line.slice(schemaImport.length).split(', '));
    expect(importedNames).toContain('safe_validate_message');
    // The #249 failure mode: a plugins/ import the bundle cannot satisfy,
    // swallowed by `except ImportError` into a disabled-validation flag.
    const stripped = lines.map((line) => line.trim());
    expect(stripped.filter((line) => line.startsWith('from _shared') || line.startsWith('import _shared'))).toStrictEqual([]);
    expect(stripped.filter((line) => line.startsWith('except ImportError'))).toStrictEqual([]);
    expect(lines.filter((line) => line.startsWith('VALIDATION_ENABLED'))).toStrictEqual([]);
  });
});

describe('the feedback processor picks up new feedback within seconds (QA 2.13.00)', () => {
  /**
   * A Manual Import took ~50 s to become visible; ~30 s of it was this event
   * source's batching window, and most of the rest was the batch's records being
   * enriched one after another. The window is now 5 s and the handler enriches
   * ENRICHMENT_CONCURRENCY records at once (lambda/processor/handler.py).
   */
  const template = synthProcessingTemplate();

  function processorFunction(): [string, Record<string, unknown>] {
    const entries = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([, fn]) => recordAt(fn, 'Properties', 'Environment', 'Variables')?.POWERTOOLS_SERVICE_NAME === 'voc-processor');
    expect(entries).toHaveLength(1);
    const [id, fn] = itemAt(entries, 0);
    return [id, propsOf(fn)];
  }

  function processorMapping(): Record<string, unknown> {
    const [id] = processorFunction();
    const mappings = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))
      .map(propsOf)
      .filter((props) => JSON.stringify(props.FunctionName ?? '').includes(id));
    expect(mappings).toHaveLength(1);
    return itemAt(mappings, 0);
  }

  it('waits at most 5 s to fill a batch of at most 10', () => {
    const mapping = processorMapping();
    expect(mapping.MaximumBatchingWindowInSeconds).toBe(5);
    expect(mapping.BatchSize).toBe(10);
  });

  it('keeps per-record partial-batch failures', () => {
    expect(processorMapping().FunctionResponseTypes).toStrictEqual(['ReportBatchItemFailures']);
  });

  it('tells the handler to enrich 5 records at a time', () => {
    const [, props] = processorFunction();
    expect(recordAt(props, 'Environment', 'Variables')?.ENRICHMENT_CONCURRENCY).toBe('5');
  });
});
