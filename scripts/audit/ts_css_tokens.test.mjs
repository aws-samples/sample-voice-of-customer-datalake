import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { analyzeCss } from './ts_css_tokens.mjs'
import { kinds, tempTree } from './ts_audit_fixture.mjs'

const CSS = `
/* --commented-out: red; .in-a-comment {} */
@theme inline {
  --color-card: var(--card);
  --color-card-fg: var(--card-fg);
  --color-chart-1: var(--chart-1);
  --color-tone: var(--tone);
  --animate-rise: rise .3s ease;
  --animate-shimmer: shimmer 1s infinite;
  --font-sans: var(--font-body);
  @keyframes rise { from { opacity: 0 } to { opacity: 1 } }
  @keyframes shimmer { 0% { opacity: 0 } 100% { opacity: 1 } }
}
:root { --card: #fff; --card-fg: #000; --font-body: sans-serif; --chart-1: #f0f; --chart-2: #0ff; --tone: red; --raw-read: 1px; --dead-raw: 2px; }
@layer components {
  .card { @apply bg-card; box-shadow: var(--raw-read); }
  .badge-ok { color: green; }
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .uses-keyframes { animation: pop 1s; }
}
@keyframes pop { from { opacity: 0 } }
@keyframes never { from { opacity: 0 } }
.voc .react-flow__node { --xy-node-color: var(--card); }
`
const SOURCE = `
export const a = <div className="voc card animate-rise hover:text-chart-1/50 uses-keyframes" />
export const badge = (t: string) => \`badge-\${t}\`
export const step = (n: number) => \`var(--chart-\${n})\`
export const utility = (t: string) => \`text-\${t}\`
`

test('reports dead properties (fixed point through @theme), keyframes and classes; quiet on used look-alikes', () => {
  const dir = tempTree({ 'src/main.tsx': SOURCE })
  try {
    const { findings, properties } = analyzeCss({ stylesheets: [{ rel: 'src/index.css', text: CSS }], sources: [join(dir, 'src/main.tsx')] })
    assert.deepEqual(kinds(findings), {
      'css:--color-card-fg': 'unused-property', // no `*-card-fg` utility is written…
      'css:--card-fg': 'unused-property', // …so the raw value only it reads is dead too
      'css:--color-tone': 'unused-property', // `text-${t}`: Tailwind generates no utility from a template
      'css:--tone': 'unused-property',
      'css:--animate-shimmer': 'unused-property',
      'css:@keyframes shimmer': 'unused-keyframes', // only the dead --animate-shimmer names it
      'css:@keyframes never': 'unused-keyframes',
      'css:--dead-raw': 'unused-property',
      'css:.scrollbar-hide': 'unused-class',
    })
    // Live: --color-card (@apply), --color-chart-1 (variant + opacity), --animate-rise/rise, --raw-read (var),
    // --chart-2 (`--chart-${n}` family read), .badge-ok (`badge-${t}`), pop (a rule's animation), the library
    // namespaces and preflight's --font-sans with the --font-body it reads.
    assert.equal(properties, 16)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
