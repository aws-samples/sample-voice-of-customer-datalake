/**
 * Test support: synth context with every context-gated feature on.
 *
 * The default synth leaves out the inbound-email intake, participant email + the board pool, the
 * verification fixture provider, the engineering agents' connector broker, the voice personas' relay, a model pin and
 * Bedrock model access
 * (data protection is on by default since 5.74.00; this shape sets it explicitly). A template gate that
 * reads only the default shape never sees those resources, so suites that judge the WHOLE app (the nag
 * suppression audit, the template gates) synthesize this shape as well. It mirrors the audit synth's
 * GATED_CONTEXT (scripts/audit/py_assembly.py) plus data protection.
 *
 * The hard delete (`-c workspaceHardDelete=true`, lib/utils/workspace-hard-delete.ts) is added by the suites that
 * judge the whole app, with this shape, through the harness's option (lib/test-support/synth-app.ts
 * `HARD_DELETE_BUILD`).
 *
 * Every feature here is FREE when idle. The opt-in fixed costs (`snapStart`, `enableWaf`, `performanceTier`) are
 * deliberately left out: lib/fixed-cost-guard.test.ts requires this shape to have no fixed cost, and synthesizes each
 * of them on its own (OPT_IN_FIXED_COSTS in test-support/fixed-cost-rules.ts). The per-user `cognitoPlus` plan is
 * left out too (it raises every active user's price); lib/opt-in-security.test.ts synthesizes it.
 *
 * Not a superset of the default shape (measured: the default synth carries VocWebSearchStack model-access
 * grants this one does not), so suites synthesize both shapes rather than this one alone.
 */
export const ALL_FEATURES_CONTEXT: Readonly<Record<string, unknown>> = {
  enableVerificationFixtureProvider: true,
  engineeringAgents: true,
  defaultModelId: 'global.anthropic.claude-sonnet-5-5',
  inboundEmailDomain: 'voc.example.com',
  emailFrom: 'noreply@voc.example.com',
  protectData: true,
  // The voice personas' relay (7.69.00, lib/stacks/voice-relay.ts): an AgentCore Runtime billed per session only.
  // Not in the audit synth's GATED_CONTEXT, whose eu scope and Region refuse it (lib/utils/voice-personas.ts).
  voicePersonas: true,
  anthropicUseCase: {
    companyName: 'Example Air', companyWebsite: 'https://example.com', intendedUsers: '0',
    industryOption: 'Technology', useCases: 'Nag suppression audit synth.', otherIndustryOption: '',
  },
};
