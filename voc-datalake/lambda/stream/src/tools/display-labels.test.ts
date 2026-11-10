import { describe, expect, it } from 'vitest';
import { categoryLabeller, humanizeId } from './display-labels.js';
import spellings from './display-spellings.json';

/** The SPA's helper and its spec: the source of the rules this file mirrors. */
const spaFiles = import.meta.glob<string>('../../../../frontend/src/utils/displayLabels{,.test}.ts', {
  eager: true, query: '?raw', import: 'default',
});
const spaSource = Object.entries(spaFiles).find(([path]) => !path.endsWith('.test.ts'))?.[1] ?? '';
const spaSpec = Object.entries(spaFiles).find(([path]) => path.endsWith('.test.ts'))?.[1] ?? '';

function spaHumanizeExamples(): [string, string][] {
  const block = spaSpec.split("describe('humanizeId'")[1]?.split('])(')[0] ?? '';
  return [...block.matchAll(/\['([^']*)', '([^']*)'\]/g)].map((m) => [m[1] ?? '', m[2] ?? '']);
}

function spaSpellings(): Record<string, string> {
  const block = spaSource.split('const SPELLINGS')[1]?.split('}')[0] ?? '';
  const pairs = block.split('{')[1]?.split(',') ?? [];
  return Object.fromEntries(pairs.map((pair) => pair.split(':').map((part) => part.trim().replaceAll("'", '')))
    .filter((pair) => pair.length === 2 && pair[0] !== ''));
}

const CONFIG = [
  { name: 'software_firmware', description: 'Software & Firmware', subcategories: [{ name: 'firmware_updates', description: 'Firmware Updates' }] },
  { name: 'ease_of_use', description: '', subcategories: [{ name: 'installation_setup', description: 'Installation & Setup' }] },
  { name: 'pricing', description: 'Everything about price. '.repeat(5) },
];

describe('display labels (lockstep with frontend/src/utils/displayLabels.ts)', () => {
  it('finds the SPA examples and spelling table', () => {
    expect([spaHumanizeExamples().length >= 8, Object.keys(spaSpellings()).length > 30]).toStrictEqual([true, true]);
  });

  it('humanises every SPA example the same way', () => {
    const examples = spaHumanizeExamples();
    expect(examples.map(([id]) => humanizeId(id))).toStrictEqual(examples.map(([, label]) => label));
  });

  it('spells words from the same table', () => {
    expect(spellings).toStrictEqual(spaSpellings());
  });
});

describe('categoryLabeller', () => {
  const labels = categoryLabeller(CONFIG);

  it('prefers a short configured name, else humanises', () => {
    expect([labels.category('software_firmware'), labels.category('ease_of_use'), labels.category('pricing'), labels.category('ux_issues')])
      .toStrictEqual(['Software & Firmware', 'Ease of use', 'Pricing', 'UX issues']);
  });

  it('finds a subcategory under its parent, then anywhere, else humanises', () => {
    expect([
      labels.subcategory('firmware_updates', 'software_firmware'),
      labels.subcategory('installation_setup'),
      labels.subcategory('tac_services', 'software_firmware'),
    ]).toStrictEqual(['Firmware Updates', 'Installation & Setup', 'Tac services']);
  });

  it('humanises everything without a configuration', () => {
    expect(categoryLabeller().category('software_firmware')).toBe('Software firmware');
  });
});
