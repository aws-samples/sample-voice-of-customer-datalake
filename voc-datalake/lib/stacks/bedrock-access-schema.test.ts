/**
 * `AnthropicUseCaseSchema` validates the `anthropicUseCase` block of cdk.context.json before the
 * Bedrock model-access custom resource submits it. Pinned after the zod 3 → 4 move
 * (`z.string().url()` → `z.url()`), so a URL the form used to accept or refuse keeps that answer.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicUseCaseSchema } from './bedrock-access-stack';

const VALID = {
  companyName: 'Example Corp',
  companyWebsite: 'https://www.example.com',
  useCases: 'Analysing customer feedback with Claude',
};

describe('AnthropicUseCaseSchema', () => {
  it('accepts a complete use case and fills the documented defaults', () => {
    expect(AnthropicUseCaseSchema.parse(VALID)).toStrictEqual({
      ...VALID,
      intendedUsers: '0',
      industryOption: 'Technology',
      otherIndustryOption: '',
    });
  });

  it.each(['not a url', 'www.example.com', ''])('refuses %j as the company website with its own message', (website) => {
    const result = AnthropicUseCaseSchema.safeParse({ ...VALID, companyWebsite: website });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toStrictEqual([
      ['companyWebsite', 'Company website must be a valid URL'],
    ]);
  });

  it('reports every missing required field by name', () => {
    const result = AnthropicUseCaseSchema.safeParse({ companyName: '', useCases: 'short' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.')).sort((a, b) => a.localeCompare(b))).toStrictEqual([
      'companyName', 'companyWebsite', 'useCases',
    ]);
  });

  it('refuses an intendedUsers index outside 0-2', () => {
    expect(AnthropicUseCaseSchema.safeParse({ ...VALID, intendedUsers: '3' }).success).toBe(false);
  });
});
