import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { summarizeFeedback, toFeedbackSource } from '../assistant/tools/server/feedback-shape.js';
import { plainReviewText, withPlainReviewText } from './review-text.js';

// The cases the SPA and the Web Reviews ingestor pin too (read at run time: outside this package's rootDir).
const CasesSchema = z.object({ cases: z.array(z.object({ input: z.string(), output: z.string() })) });
// lambda/stream/src/tools -> voc-datalake/schemas; built from static parts only, so a fixed repo file.
const casesPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../schemas/review-text-cleanup-cases.json');
const { cases } = CasesSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8')));

describe('plainReviewText', () => {
  it.each(cases)('reads "$input" as plain text', ({ input, output }) => {
    expect(plainReviewText(input)).toBe(output);
  });
});

describe('the assistant quotes stored reviews without markdown escapes', () => {
  const stored = { feedback_id: 'f1', original_text: 'Hard situation\\.On **time** next day', title: '**Fine**', rating: 4 };

  it('in the summary the model reads and the source card the SPA shows', () => {
    expect(summarizeFeedback(stored)).toMatchObject({ original_text: 'Hard situation. On time next day', title: 'Fine' });
    expect(toFeedbackSource(stored)).toMatchObject({ original_text: 'Hard situation. On time next day', title: 'Fine' });
  });

  it('without changing the stored record', () => {
    expect(withPlainReviewText(stored)).not.toBe(stored);
    expect(stored.original_text).toBe('Hard situation\\.On **time** next day');
  });
});
