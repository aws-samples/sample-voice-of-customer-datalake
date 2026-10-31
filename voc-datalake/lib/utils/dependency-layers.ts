import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { pythonLayerCode } from './python-layer-bundling';

/**
 * The Python dependency layers and who gets which (docs/lambda-sizing.md → "Dependency layers").
 *
 * A layer is unzipped into every function it is attached to, so a library only a few functions
 * import goes in a small layer of its own, attached to exactly those. The split is derived from
 * the code, not by hand: `scripts/audit/py_layers.py` (a gate step) reports a function whose live
 * code imports a library none of its layers ships (`missing-distribution`), a function attached to
 * a layer it reaches nothing of (`unused-layer`), and a library under a third of its layer's
 * functions (`narrow-distribution`). `dependency-layers.test.ts` pins the template to the lists here.
 */

/** One `LayerVersion` built from `lambda/layers/<dir>/requirements.txt` (arm64, Python 3.14). */
export function dependencyLayer(scope: Construct, id: string, layerDir: string, description: string): lambda.LayerVersion {
  return new lambda.LayerVersion(scope, id, {
    code: pythonLayerCode(layerDir),
    compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
    compatibleArchitectures: [lambda.Architecture.ARM_64],
    description,
  });
}

/** cryptography (+ cffi, pycparser): the RSA-SHA1 primitive of `shared/cloudfront_signing.py`. */
export const SIGNING_LAYER_DIR = 'lambda/layers/signing-deps';

/**
 * The VocApiStack functions whose live code reaches `shared/cloudfront_signing.py` (persona avatars and
 * prototype URLs: `shared/avatar.py`, `shared/prototypes.py`, `api/projects_handler.py`), as `py_layers`
 * finds them. A function added to or dropped from that set fails the `py_layers` gate step until it
 * is added here or removed.
 */
export const SIGNING_LAYER_FUNCTION_IDS: readonly string[] = [
  'ProjectsApi', 'ProjectsAssistWorker', 'PersonaGeneratorJob', 'PersonaImporterJob', 'DocumentGeneratorJob',
];

/*
 * The same cryptography also VERIFIES RS256 signatures on the global MCP endpoint (`shared/mcp_oauth_jwt.py`,
 * MCP OAuth access tokens): api-mcp-oauth.ts attaches the layer that attachSigningLayer returns to that one
 * function (pinned in dependency-layers.test.ts).
 */

/** lxml: the HTML parser the inbound-email intake hands to BeautifulSoup (`email_intake/mime.py`). */
export const EMAIL_INTAKE_LAYER_DIR = 'lambda/layers/email-intake-deps';

/**
 * Creates the signing layer in `stack` and adds it to each function named by
 * {@link SIGNING_LAYER_FUNCTION_IDS}. Call it after those functions exist; a name that matches no
 * function of the stack throws, so a renamed function cannot silently lose the layer.
 */
export function attachSigningLayer(stack: Construct): lambda.LayerVersion {
  const functions = new Map(stack.node.children
    .filter((child): child is lambda.Function => child instanceof lambda.Function)
    .map((fn) => [fn.node.id, fn]));
  const targets = SIGNING_LAYER_FUNCTION_IDS.map((id) => {
    const fn = functions.get(id);
    if (fn === undefined) {
      throw new Error(`attachSigningLayer: ${stack.node.id} has no function '${id}'`);
    }
    return fn;
  });
  const layer = dependencyLayer(stack, 'SigningDepsLayer', SIGNING_LAYER_DIR,
    'CloudFront URL-signing crypto for the projects and persona Lambdas (ARM64/Graviton)');
  for (const fn of targets) fn.addLayers(layer);
  return layer;
}
