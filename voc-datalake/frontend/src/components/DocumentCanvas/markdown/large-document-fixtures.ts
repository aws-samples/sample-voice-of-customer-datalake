/**
 * @fileoverview A long document for the large-document specs: sections of every block the canvas edits (headings,
 * prose with bold, links and citations, lists, a to-do list, a quote, a callout, a table, code), repeated until the
 * text is at least `characters` long. A revise pass stores at most 60,000 characters; a document can be longer.
 */
const section = (n: number): string => [
  `## Finding ${String(n)}: delivery and tracking`,
  '',
  `Customers in segment ${String(n)} mention **late deliveries** most, and *tracking opacity* makes it worse [FR:fr_${String(n)}]. ` +
    'See the [delivery report](https://example.com/report) and the `eta` field for details.',
  '',
  '- Mobile app users mention it twice as often as web users',
  '- "Where is my order?" contacts rose 18% month over month',
  '  - most of them in the first week',
  '',
  '1. Show the carrier and the next scan',
  '2. Notify on every delay',
  '',
  '- [ ] Draft the tracking page',
  '- [x] Size the notification volume',
  '',
  '> "I just want to know when it will arrive." (App Store review, 2 stars)',
  '',
  '> [!NOTE]',
  '> Confidence is high: 214 of 260 reviews agree.',
  '',
  '| Metric | Value |',
  '| --- | --- |',
  `| Reviews | ${String(200 + n)} |`,
  '| Negative | 62% |',
  '',
  '```ts',
  `const eta = estimate(order${String(n)})`,
  '```',
].join('\n')

export function largeMarkdown(characters: number): string {
  // Later sections are never shorter than the first (their numbers have more digits): one more is enough.
  const count = Math.ceil(characters / section(1).length) + 1
  return ['# A long research document', ...Array.from({ length: count }, (_, index) => section(index + 1))].join('\n\n')
}
