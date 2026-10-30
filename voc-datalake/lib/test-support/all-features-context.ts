/**
 * Test support: synth context with every context-gated feature on.
 *
 * The default synth leaves out the inbound-email intake, participant email + the board pool, the
 * verification fixture provider, a model pin, Bedrock model access and data protection. A template gate that
 * reads only the default shape never sees those resources, so suites that judge the WHOLE app (the nag
 * suppression audit, the template gates) synthesize this shape as well. It mirrors the audit synth's
 * GATED_CONTEXT (scripts/audit/py_assembly.py) plus data protection.
 *
 * Not a superset of the default shape (measured: the default synth carries VocWebSearchStack model-access
 * grants this one does not), so suites synthesize both shapes rather than this one alone.
 */
export const ALL_FEATURES_CONTEXT: Readonly<Record<string, unknown>> = {
  enableVerificationFixtureProvider: true,
  defaultModelId: 'global.anthropic.claude-sonnet-5-5',
  inboundEmailDomain: 'voc.example.com',
  emailFrom: 'noreply@voc.example.com',
  protectData: true,
  anthropicUseCase: {
    companyName: 'Example Air', companyWebsite: 'https://example.com', intendedUsers: '0',
    industryOption: 'Technology', useCases: 'Nag suppression audit synth.', otherIndustryOption: '',
  },
};
