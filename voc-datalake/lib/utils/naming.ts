import { Aws } from 'aws-cdk-lib';

/**
 * Creates a unique resource name using CDK tokens.
 * Tokens resolve at deploy-time, keeping templates portable.
 */
export function uniqueName(baseName: string): string {
  return `${baseName}-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
}
