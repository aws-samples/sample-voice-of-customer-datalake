/**
 * The SPA's `cognito.hostedUiDomain` has two writers: the CDK config.json (api-stack.ts, through
 * `cognitoHostedUiHost`) and `frontend/scripts/deploy.sh`, which copies VocCoreStack's `UserPoolDomain`
 * output. The consent page navigates only to that host (frontend/src/api/oauthRedirect.ts), so a
 * prefix-only or otherwise different value would silently refuse every approval on a frontend-only
 * deploy. Pinned here: the output is exactly the host `cognitoHostedUiHost` builds from the pool's
 * own domain prefix.
 */
import { describe, expect, it } from 'vitest';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { SYNTH_REGION } from '../test-support/synth-app';
import { cognitoHostedUiHost } from './api-mcp-oauth';

/** A template value as its join parts: `Fn::Join` with an empty separator → its parts, a string → [it]. */
function joinParts(value: unknown): unknown[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null && 'Fn::Join' in value) {
    const join: unknown = value['Fn::Join'];
    if (Array.isArray(join) && join[0] === '' && Array.isArray(join[1])) return join[1];
  }
  throw new Error(`not a string or an empty-separator Fn::Join: ${JSON.stringify(value)}`);
}

/** `parts` followed by `text`, as CDK renders it: merged into a trailing string part, else its own part. */
function appendText(parts: unknown[], text: string): unknown[] {
  const last = parts.at(-1);
  return typeof last === 'string' ? [...parts.slice(0, -1), `${last}${text}`] : [...parts, text];
}

describe('the hosted UI domain the SPA navigates to', () => {
  const template = synthCoreTemplate();

  it('is VocCoreStack\u2019s UserPoolDomain output: the pool\u2019s prefix plus cognitoHostedUiHost\u2019s suffix', () => {
    const domains = Object.values(template.findResources('AWS::Cognito::UserPoolDomain'));
    expect(domains).toHaveLength(1);
    const prefixParts = joinParts(domains[0]?.Properties?.Domain);

    const outputs = Object.values(template.findOutputs('UserPoolDomain'));
    expect(outputs).toHaveLength(1);
    const suffix = cognitoHostedUiHost('', SYNTH_REGION);
    expect(joinParts(outputs[0]?.Value)).toStrictEqual(appendText(prefixParts, suffix));
  });
});
