/**
 * The document generator runs the Product tab's extract (7.104.00, lambda/shared/product_extract.py): it streams the
 * model's answer (bedrock:InvokeModelWithResponseStream on every allowlisted Claude model, beside InvokeModel), reads
 * every source's extracted text and an uploaded image itself (GetObject on product_docs/extracted/ and raw/ only, one
 * statement), and its 15 minutes cover the extract's
 * model budget plus the reserve it keeps to record its outcome (both read from the Python that keeps them).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

import { claudeRoleGrantOf, missingModelGrants, statementsWithoutStream } from '../test-support/bedrock-grants';
import { pythonIntConstant } from '../test-support/cross-language-invariants';
import { roleStatements } from '../test-support/iam-statements';
import { apiTemplate } from '../test-support/api-stack-template';
import { itemAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import { PRODUCT_SOURCE_IMAGE_READ, PRODUCT_SOURCE_TEXT_READ } from './api-job-lambdas';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const ROLE = 'DocumentGeneratorRole';
const statements = () => roleStatements(apiTemplate(), ROLE, { byIdPrefix: true });
const s3Reads = (fragment: string) => statements()
  .filter((s) => s.effect === 'Allow' && s.resource.includes(fragment))
  .flatMap((s) => s.actions);

describe('the document generator streams the product extract', () => {
  it('may stream every allowlisted Claude model it may invoke', () => {
    const grant = claudeRoleGrantOf('Api', apiTemplate().toJSON(), ROLE);
    expect(statementsWithoutStream(grant)).toStrictEqual([]);
    expect(missingModelGrants([grant], ALLOWED_MODEL_IDS, 'global')).toStrictEqual([]);
  });

  it('adds no Bedrock action beyond invoke and stream', () => {
    const grant = claudeRoleGrantOf('Api', apiTemplate().toJSON(), ROLE);
    const actions = [...new Set(grant.statements.flatMap((s) => s.actions))].sort(byCodeUnit);
    expect(actions).toStrictEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
  });

  it("reads only the product sources' extracted text and an image under raw/, in one statement, and writes none", () => {
    // Review S6 (7.104.00 round 1): the whole product_docs/ folder (source/ uploads included) was readable.
    const product = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('/product_docs/'));
    const shape = product.map((s) => ({
      actions: s.actions,
      text: s.resource.includes(PRODUCT_SOURCE_TEXT_READ),
      image: s.resource.includes(PRODUCT_SOURCE_IMAGE_READ),
      wider: s.resource.includes('product_docs/*') || s.resource.includes('product_docs/source/'),
    }));
    expect(shape).toStrictEqual([{ actions: ['s3:GetObject'], text: true, image: true, wider: false }]);
    expect(s3Reads('product_docs/source/')).toStrictEqual([]);
  });
});

describe("the document generator's timeout covers the extract's deadline", () => {
  const FunctionSchema = z.object({ Properties: z.object({ Timeout: z.number() }) });

  it('outlives the model budget plus the reserve it keeps to record the outcome', () => {
    const functions = Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => logicalId.startsWith('DocumentGeneratorJob'));
    expect(functions).toHaveLength(1);
    const timeout = FunctionSchema.parse(itemAt(functions, 0)[1]).Properties.Timeout;
    const budget = pythonIntConstant('MODEL_BUDGET_SECONDS', 'lambda', 'shared', 'product_extract_model.py');
    const reserve = pythonIntConstant('FINISH_RESERVE_SECONDS', 'lambda', 'shared', 'product_extract_model.py');
    expect(budget + reserve).toBeLessThanOrEqual(timeout);
    expect(timeout).toBe(900);
  });
});
