/**
 * Where the Radar news scan's Exa API key lives (docs/radar.md → "Exa"): an SSM Parameter Store
 * SecureString, standard tier (no monthly cost), encrypted with the AWS-managed `alias/aws/ssm`
 * key. CloudFormation never creates it: `PUT /radar/settings/exa-key` (voc-radar-api) writes it and
 * `DELETE` removes it, so the parameter exists only while an admin wants Exa.
 *
 * The name is per deployment: `/voc/radar/exa-api-key`, or `/<prefix>-voc/radar/exa-api-key` on a
 * prefixed one (the prefix on the `voc` segment, as `DeploymentNaming.prefixed` places it). SSM is
 * account- and region-scoped, so the account and region need not be in the name.
 *
 * No KMS grant: the `aws/ssm` key policy admits every principal of the account through SSM.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

const RADAR_EXA_PARAMETER_PATH = 'voc/radar/exa-api-key';

/** `/[<prefix>-]voc/radar/exa-api-key` (the env value `RADAR_EXA_PARAMETER` of both Radar Lambdas). */
export function radarExaParameterName(deploymentPrefix: string | undefined): string {
  return deploymentPrefix ? `/${deploymentPrefix}-${RADAR_EXA_PARAMETER_PATH}` : `/${RADAR_EXA_PARAMETER_PATH}`;
}

/** The parameter's ARN in `stack`'s account and region. */
function radarExaParameterArn(stack: cdk.Stack, deploymentPrefix: string | undefined): string {
  return stack.formatArn({
    service: 'ssm', resource: 'parameter', resourceName: radarExaParameterName(deploymentPrefix).slice(1),
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/** Exactly `actions` on the Exa key parameter, nothing else. */
export function radarExaParameterStatement(stack: cdk.Stack, deploymentPrefix: string | undefined,
  actions: readonly string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'RadarExaKeyParameter', actions: [...actions], resources: [radarExaParameterArn(stack, deploymentPrefix)],
  });
}
