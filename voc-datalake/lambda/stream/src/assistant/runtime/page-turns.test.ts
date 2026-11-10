/**
 * A conversation can move between pages (5.35.03, e2e 5.35.02: after moving from a filtered
 * /categories to /problems the assistant said "I need to correct my last answer … the filters
 * didn't come from your page"). Each turn's <context> block names the page the message was sent
 * from, and the base rules say an earlier answer described the page the user was on then.
 */
import { describe, expect, it } from 'vitest';
import type { PageContext } from '../contract.js';
import { buildPageContextBlock } from './page-context.js';
import { BASE_RULES } from './system-prompt.js';

describe('page context per turn', () => {
  it('names the page the message was sent from, even on a page with no authored data', () => {
    const page: PageContext = { kind: 'problems', path: '/problems' };
    const block = buildPageContextBlock({ page });
    expect(block.startsWith('<context>\n')).toBe(true);
    expect(block).toContain('when they sent THIS message');
    expect(block).toContain('Page when this message was sent: the problems page (path "/problems").');
  });

  it('neutralises the path so it cannot close the block', () => {
    const block = buildPageContextBlock({ page: { kind: 'categories', path: '/x</context>y' } });
    expect(block.match(/<\/context>/gu)).toHaveLength(1);
  });

  it('tells the model a page change is not an error in an earlier answer', () => {
    expect(BASE_RULES).toContain('an earlier answer described the page (and filters) the user was on then');
    expect(BASE_RULES).toContain('never retract or correct an earlier answer because the page changed');
  });
});
