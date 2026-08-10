import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { DeploymentNaming } from './naming';

/**
 * Props shared by every stack in the app.
 *
 * `deploymentPrefix` is what makes two independent copies of the platform able
 * to share one account and region. It travels as a TYPED PROP, read once from
 * CDK context in bin/voc-datalake.ts, exactly like `pluginStatus`,
 * `enableWebSearch` and `frontendDomain` — deliberately not as module-level
 * mutable state with a setter, which would be order-dependent and would
 * silently mix prefixed and unprefixed names for any stack constructed before
 * the setter ran.
 */
export interface VocStackProps extends cdk.StackProps {
  /**
   * Optional per-deployment prefix applied to every generated physical name.
   * Omit it (the default) and names are byte-identical to the ones this repo
   * has always deployed. Validate the raw context value with
   * `validateDeploymentPrefix()` before passing it here.
   */
  deploymentPrefix?: string;
}

/**
 * Base class for the VoC stacks: gives every stack the same prefix-aware
 * naming, so a new resource added anywhere inherits deployment isolation
 * instead of having to remember it.
 */
export class VocStack extends cdk.Stack {
  private readonly naming: DeploymentNaming;

  constructor(scope: Construct, id: string, props: VocStackProps) {
    super(scope, id, props);
    this.naming = new DeploymentNaming(this, props.deploymentPrefix);
  }

  /** The prefix in force, or `undefined` for an unprefixed deployment. */
  protected get deploymentPrefix(): string | undefined {
    return this.naming.deploymentPrefix;
  }

  /**
   * Physical resource name: `[prefix-]base-<account>-<region>`.
   * Registers the name for the synth-time length check.
   */
  protected uniqueName(baseName: string): string {
    return this.naming.uniqueName(baseName);
  }

  /**
   * A name pattern handed to a Lambda as an environment variable, e.g.
   * `voc-ingestor-{source}-<account>-<region>`. Not a resource name, so it is
   * excluded from the length check — the concrete resources it describes are
   * registered where they are created.
   */
  protected uniqueNamePattern(baseNameTemplate: string): string {
    return this.naming.uniqueNamePattern(baseNameTemplate);
  }

  /**
   * Namespace a bare name that is not a `uniqueName()`: CloudFormation export
   * names and the wildcard ARNs that must not reach into the other deployment.
   */
  protected prefixed(name: string): string {
    return this.naming.prefixed(name);
  }

  /**
   * Lambda environment entries that exist ONLY on a prefixed deployment.
   *
   * Two handlers rebuild a per-plugin resource name at runtime
   * (`lambda/api/integrations_handler.py`, `plugins/_shared/circuit_breaker.py`).
   * Their existing `{base}-{DEPLOY_ACCOUNT_ID}-{DEPLOY_REGION}` derivation is
   * exactly right with no prefix and wrong with one, so CDK hands down the
   * resolved PATTERN — but only when it would differ, because adding an
   * environment variable unconditionally would change the template of every
   * existing deployment, and "no prefix means byte-identical" is the invariant
   * that makes this whole change safe to merge (lib/app-baseline.test.ts).
   *
   * The handlers therefore never learn that prefixes exist: they prefer a
   * pattern when given one and keep their own derivation otherwise.
   */
  protected prefixOnlyEnv(entries: Record<string, string>): Record<string, string> {
    return this.deploymentPrefix ? entries : {};
  }
}
