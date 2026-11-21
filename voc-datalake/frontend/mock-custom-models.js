// The deployment's own models (7.65.00, `-c customModels`, docs/deployment.md "Bring your own model"), as
// lambda/api/settings_handler.py answers them in `GET /settings/model` (`custom_models`), and the checks of
// `POST /settings/model/test` (`probe`: basic | json | tools) as shared/model_capacity.py answers them.
//
// Two fictional models, so `npm run dev` shows the "Your models" group, the badges, the residency line and the
// checks: a `us.` inference profile (no tools, so its tools check answers probe_failed) and an imported model (the
// cold-start note). Kept apart from mock-server.js's `mockAvailableModels`, the Claude list a Python lockstep test
// reads. Wired into mock-server.js's `GET`/`PUT /settings/model` and `POST /settings/model/test`.

export const MOCK_CUSTOM_MODELS = [
  {
    key: 'llama33', id: 'us.meta.llama3-3-70b-instruct-v1:0', label: 'Llama 3.3 70B Instruct', description: '',
    kind: 'bedrock', source: 'profile', surfaces: ['documents', 'utility', 'prototype'], eu: false,
    regions: ['us-east-1', 'us-east-2', 'us-west-2'],
    capabilities: { tools: false, documents: false, json: true, temperature: true }, price: { in: 0.72, out: 0.72 },
  },
  {
    key: 'examplechat', id: 'arn:aws:bedrock:us-east-1:111111111111:imported-model/abcd1234efgh',
    label: 'Example imported model', description: '', kind: 'imported', source: 'imported',
    surfaces: ['enrichment', 'memory'], eu: false, regions: ['us-east-1'],
    capabilities: { tools: false, documents: false, json: true, temperature: true }, price: { in: 0.5, out: 1.5 },
  },
];

const PROBES = ['basic', 'json', 'tools'];

/** The custom models that may serve `surface` (shared/model_config.py surface_allowlist adds them). */
export function mockCustomModelsFor(surface) {
  return MOCK_CUSTOM_MODELS.filter((model) => model.surfaces.includes(surface));
}

/** The `probe` of a test body: basic when absent; null when it names no known check (a 400). */
export function mockProbeOf(body) {
  const probe = body?.probe ?? 'basic';
  return PROBES.includes(probe) ? probe : null;
}

/** The answer of a test of custom model `modelId` with `probe`, or null when the id is not one of them. A model
 *  without tools fails the tools check (it answered with text, not the check's tool call). */
export function mockCustomModelTest(modelId, probe, run) {
  const model = MOCK_CUSTOM_MODELS.find((m) => m.id === modelId);
  if (!model) return null;
  const failed = probe === 'tools' && !model.capabilities.tools;
  return {
    model_id: model.id, invoked_id: model.id, status: failed ? 'probe_failed' : 'available', ok: !failed, probe,
    latency_ms: failed ? null : 1100 + (run % 5) * 150,
    message: failed ? 'The model answered, but not as the check asked.' : 'The model answered.',
    quota: null, checked_at: new Date().toISOString(),
  };
}
