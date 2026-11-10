// Design-system components (wave 13, THE CONTRACT in docs/company-context.md): KiroCrew-like
// components a reference yields, the ones the mock design system starts with, and the merge the
// apply route performs (same name case-insensitive replaced, new appended, ≤ 30). Fixtures only —
// mock-design-extract.js and mock-server.js own the routes.

const MAX_COMPONENTS = 30;
const MAX_VARIANTS = 6;

const variant = (name, styles, extra = {}) => ({ name, styles, ...extra });

const BUTTON = {
  name: 'Button',
  description: 'Actions. One primary per card; secondary actions as outline or ghost.',
  variants: [
    variant('primary', { background: 'var:primary', color: '#ffffff', radius: '8px', padding: '8px 16px', font_family: 'Space Grotesk, sans-serif', font_size: '14px', font_weight: '600' },
      { hover: { background: 'var:primary-hover', shadow: '0 0 0 4px rgba(142, 72, 255, 0.3)' }, focus: { outline: '2px solid #8e48ff' } }),
    variant('outline', { background: 'transparent', color: 'var:text', border_color: 'var:border', border_width: '1px', radius: '8px', padding: '8px 16px', font_size: '14px', font_weight: '500' },
      { hover: { border_color: 'var:muted' }, focus: { outline: '2px solid #8e48ff' } }),
    variant('ghost', { background: 'transparent', color: 'var:muted', radius: '8px', padding: '8px 12px', font_size: '14px' },
      { hover: { background: 'var:surface-raised', color: 'var:text' } }),
  ],
  example_html: '<button type="button" style="background:#8e48ff;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-weight:600">Save changes</button>',
};

const CARD = {
  name: 'Card',
  description: 'Groups one topic. Raised one step from the page, 1px border, 12px corners.',
  variants: [variant('default', { background: 'var:surface-raised', color: 'var:text', border_color: 'var:border', border_width: '1px', radius: '12px', padding: '16px', shadow: '0 1px 2px rgba(0, 0, 0, 0.3)' })],
};

const INPUT = {
  name: 'Input',
  description: 'Single-line text. Label above, placeholder as a hint only.',
  variants: [variant('default', { background: 'var:surface', color: 'var:text', border_color: '#77727f', border_width: '1px', radius: '6px', padding: '6px 10px', height: '36px', font_size: '14px' },
    { focus: { outline: '2px solid #8e48ff' } })],
};

const BADGE = {
  name: 'Badge',
  description: 'A short status or label. Tone by meaning, never to tell labels apart.',
  variants: [
    variant('muted', { background: 'var:surface-raised', color: 'var:muted', radius: '9999px', padding: '2px 8px', font_size: '12px', font_weight: '500' }),
    variant('accent', { background: 'var:accent-soft', color: '#bd8fff', radius: '9999px', padding: '2px 8px', font_size: '12px', font_weight: '500' }),
  ],
};

const TABS = {
  name: 'Tabs',
  description: 'A top rail of sections; the selected tab is filled, never nested.',
  variants: [
    variant('selected', { background: 'var:surface-raised', color: 'var:text', radius: '6px', padding: '6px 12px', font_size: '14px', font_weight: '500' }),
    variant('idle', { background: 'transparent', color: 'var:muted', radius: '6px', padding: '6px 12px', font_size: '14px' }, { hover: { color: 'var:text' } }),
  ],
};

/** What the GitHub reference yields (components/ui/** read with cva variant maps). */
export const KIROCREW_REPO_COMPONENTS = [BUTTON, CARD, INPUT, BADGE, TABS];

/** What the live-website reference yields (computed styles of representative elements). */
export const KIROCREW_SITE_COMPONENTS = [
  { name: BUTTON.name, description: BUTTON.description, variants: BUTTON.variants.slice(0, 2) },
  CARD,
  INPUT,
];

/** The mock design system starts with an older Button and a Card, so applying shows "new" and "updated". */
export const INITIAL_COMPONENTS = [
  { name: 'button', description: 'Main actions.', variants: [variant('primary', { background: 'var:primary', color: '#ffffff', radius: '6px', padding: '6px 14px' })] },
  { name: 'Card', description: CARD.description, variants: CARD.variants },
];

/** Same name (case-insensitive) replaced in place, new appended up to 30. */
export function mergeComponents(current, incoming) {
  const merged = [...current];
  for (const component of incoming) {
    const key = component.name.trim().toLowerCase();
    const at = merged.findIndex((existing) => existing.name.trim().toLowerCase() === key);
    if (at >= 0) merged[at] = component;
    else if (merged.length < MAX_COMPONENTS) merged.push(component);
  }
  return merged;
}

/** PUT /settings/design-system `components`: an array of named components, ≤ 30 (the real API validates every value). */
export function componentsProblem(components) {
  if (!Array.isArray(components)) return 'components must be a list';
  if (components.length > MAX_COMPONENTS) return `at most ${MAX_COMPONENTS} components`;
  const names = components.map((c) => (typeof c?.name === 'string' ? c.name.trim().toLowerCase() : ''));
  if (names.some((name) => !name)) return 'every component needs a name';
  if (new Set(names).size !== names.length) return 'component names must be unique';
  if (components.some((c) => !Array.isArray(c.variants) || c.variants.length > MAX_VARIANTS)) return `at most ${MAX_VARIANTS} variants per component`;
  return null;
}
