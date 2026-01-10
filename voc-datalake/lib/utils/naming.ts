import * as crypto from 'crypto';

/**
 * Generates a short hash based on account and region for unique resource naming.
 * This allows deploying the same stack to multiple accounts/regions without conflicts.
 * 
 * @param account AWS account ID
 * @param region AWS region
 * @param length Length of the hash (default: 8)
 * @returns A short alphanumeric hash
 */
export function generateDeploymentHash(account: string, region: string, length = 8): string {
  const input = `${account}-${region}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.substring(0, length);
}

/**
 * Creates a unique resource name by appending a deployment hash.
 * Ensures resources don't conflict across different deployments.
 * 
 * @param baseName The base name for the resource
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique resource name with hash suffix
 */
export function uniqueName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}

/**
 * Creates a unique S3 bucket name.
 * S3 bucket names are globally unique, so we include account and region.
 * 
 * @param baseName The base name for the bucket
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique bucket name
 */
export function uniqueBucketName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${account}-${region}-${hash}`;
}

/**
 * Creates a unique DynamoDB table name.
 * 
 * @param baseName The base name for the table
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique table name
 */
export function uniqueTableName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}

/**
 * Creates a unique Lambda function name.
 * 
 * @param baseName The base name for the function
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique function name
 */
export function uniqueFunctionName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}

/**
 * Creates a unique SQS queue name.
 * 
 * @param baseName The base name for the queue
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique queue name
 */
export function uniqueQueueName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}

/**
 * Creates a unique Cognito User Pool name.
 * 
 * @param baseName The base name for the user pool
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique user pool name
 */
export function uniqueUserPoolName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}

/**
 * Creates a unique Step Functions state machine name.
 * 
 * @param baseName The base name for the state machine
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique state machine name
 */
export function uniqueStateMachineName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}

/**
 * Creates a unique EventBridge rule name.
 * 
 * @param baseName The base name for the rule
 * @param account AWS account ID
 * @param region AWS region
 * @returns A unique rule name
 */
export function uniqueRuleName(baseName: string, account: string, region: string): string {
  const hash = generateDeploymentHash(account, region);
  return `${baseName}-${hash}`;
}
