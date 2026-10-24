/**
 * Regression (prod 5.14): the assistant wrote raw category ids ("software_firmware",
 * "ease_of_use") because the tool results it reads carried ids only. Each result now carries
 * the display label beside the id.
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';

const CONFIG = {
  categories: [
    { name: 'software_firmware', description: 'Software & Firmware', subcategories: [{ name: 'ota', description: 'Over-the-air updates' }] },
    { name: 'ease_of_use', description: '' },
  ],
};
const ALL = { all: true, categories: ['*'], sources_all: true, sources: [], source_rule: 'all', sources_denied: [] };
const ITEM = { feedback_id: 'f1', category: 'software_firmware', subcategory: 'ota', original_text: 'Update bricked it' };

describe('category labels in tool results', () => {
  it('list_feedback: each item carries category_label and subcategory_label next to the ids', async () => {
    const deps = fakeDeps({ 'GET /feedback': { items: [ITEM], total: 1 }, 'GET /settings/categories': CONFIG });
    const result = await serverTool(deps, 'list_feedback').execute({}, fakeContext());
    expect(JSON.parse(result.content).items[0]).toMatchObject({
      category: 'software_firmware', category_label: 'Software & Firmware', subcategory: 'ota', subcategory_label: 'Over-the-air updates',
    });
  });

  it('get_urgent_feedback: a category without a short name reads as its humanised id', async () => {
    const deps = fakeDeps({ 'GET /feedback/urgent': { items: [{ feedback_id: 'f2', category: 'ease_of_use' }] }, 'GET /settings/categories': CONFIG });
    const result = await serverTool(deps, 'get_urgent_feedback').execute({}, fakeContext());
    expect(JSON.parse(result.content).items[0].category_label).toBe('Ease of use');
  });

  it('get_metrics categories: a label map beside the {id: count} breakdown', async () => {
    const deps = fakeDeps({ 'GET /metrics/categories': { categories: { software_firmware: 4, ease_of_use: 2 } }, 'GET /settings/categories': CONFIG });
    const result = await serverTool(deps, 'get_metrics').execute({ metric: 'categories' }, fakeContext());
    expect(JSON.parse(result.content).category_labels).toStrictEqual({ software_firmware: 'Software & Firmware', ease_of_use: 'Ease of use' });
  });

  it('get_radar: nested themes and compare rows are labelled; a config read failure humanises', async () => {
    const deps = fakeDeps({ 'GET /radar/brands/acme': { hate: [{ category: 'software_firmware', subcategory: 'ota', count: 3 }] } });
    const result = await serverTool(deps, 'get_radar').execute({ brand: 'acme', view: 'summary' }, fakeContext());
    expect(JSON.parse(result.content).hate[0]).toMatchObject({ category_label: 'Software firmware', subcategory_label: 'Ota' });
  });

  it('get_radar: a result without categories reads no configuration', async () => {
    const deps = fakeDeps({ 'GET /radar': { brands: [] } });
    await serverTool(deps, 'get_radar').execute({}, fakeContext());
    expect(deps.calls.map(({ call }) => call.path)).toStrictEqual(['/radar']);
  });

  it('list_categories: a category without a product or subcategory description is still listed', async () => {
    const deps = fakeDeps({ 'GET /feedback/access': ALL, 'GET /settings/categories': CONFIG });
    const result = await serverTool(deps, 'list_categories').execute({}, fakeContext());
    expect(JSON.parse(result.content).categories.map((c: { name: string }) => c.name)).toStrictEqual(['software_firmware', 'ease_of_use']);
  });

  it('search_feedback: the search is given the label function of the configuration', async () => {
    const seen: string[] = [];
    const deps = fakeDeps({ 'GET /feedback/access': ALL, 'GET /settings/categories': CONFIG }, {
      searchFeedback: (_input, filters) => {
        seen.push(filters.categoryLabel?.('software_firmware') ?? '');
        return Promise.resolve({ items: [], formatted: '' });
      },
    });
    await serverTool(deps, 'search_feedback').execute({ query: 'update' }, fakeContext());
    expect(seen).toStrictEqual(['Software & Firmware']);
  });
});
