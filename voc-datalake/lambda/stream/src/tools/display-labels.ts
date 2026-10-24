/**
 * Category / subcategory ids → the labels a person reads, for the assistant's tool results.
 *
 * Same rules as the SPA (`frontend/src/utils/displayLabels.ts`) and the brief
 * (`lambda/shared/display_labels.py`): a configured `description` wins when it reads as a label
 * (non-empty, one line, ≤ 60 characters), else the humanised id — underscores → spaces, the
 * first letter raised, known acronyms spelled their own way (`software_firmware` →
 * `Software firmware`, `api_automation` → `API automation`). `display-labels.test.ts` pins the
 * examples and the spelling table to the SPA's. Ids are never changed: results carry the label
 * NEXT TO the id, which the model still needs for filters.
 */
import spellings from './display-spellings.json';

const SPELLING = new Map<string, string>(Object.entries(spellings));
const LABEL_MAX = 60;

/** `existing_customer` → `Existing customer`; a dotted first word (a package name) keeps its case. */
export function humanizeId(id: string): string {
  const words = id.split(/[_ ]+/).filter((word) => word !== '').map((word) => SPELLING.get(word.toLowerCase()) ?? word);
  if (words.length === 0) return '';
  const [head = '', ...tail] = words;
  const first = SPELLING.get(head.toLowerCase()) ?? (head.includes('.') ? head : head.charAt(0).toUpperCase() + head.slice(1));
  return [first, ...tail].join(' ');
}

/** One configured (sub)category row as the settings route returns it. */
export interface LabelSource {
  readonly name: string;
  readonly description?: string;
  readonly subcategories?: readonly LabelSource[];
}

function asLabel(description: string | undefined): string | undefined {
  const text = (description ?? '').trim();
  return text !== '' && text.length <= LABEL_MAX && !text.includes('\n') ? text : undefined;
}

/** Turns ids into labels against one category configuration. */
export interface CategoryLabeller {
  category(id: string): string;
  subcategory(id: string, parent?: string): string;
}

export function categoryLabeller(config: readonly LabelSource[] = []): CategoryLabeller {
  const byName = new Map(config.map((entry) => [entry.name, entry]));
  const findSub = (id: string, parent?: string): LabelSource | undefined => {
    const own = parent === undefined ? undefined : byName.get(parent)?.subcategories?.find((s) => s.name === id);
    return own ?? config.flatMap((entry) => entry.subcategories ?? []).find((s) => s.name === id);
  };
  return {
    category: (id) => asLabel(byName.get(id)?.description) ?? humanizeId(id),
    subcategory: (id, parent) => asLabel(findSub(id, parent)?.description) ?? humanizeId(id),
  };
}
