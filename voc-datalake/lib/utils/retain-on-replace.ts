/**
 * Keep a data resource when CloudFormation REPLACES it, while still deleting it with its stack.
 *
 * `RemovalPolicy.DESTROY` sets BOTH `DeletionPolicy` and `UpdateReplacePolicy` to Delete,
 * so any change that forces a replacement (a renamed table or bucket, a changed key
 * schema, a create-only Cognito attribute) would silently delete the old resource and
 * every row, object or user in it. Teardown is the only deletion the owner chose
 * (docs/deployment.md, "Teardown deletes everything"); a replacement must leave the old
 * resource behind for an operator to migrate or remove.
 */
import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

export function retainOnReplace<T extends IConstruct>(construct: T): T {
  const resource = construct.node.defaultChild;
  if (!(resource instanceof cdk.CfnResource)) {
    throw new TypeError(`retainOnReplace: ${construct.node.path} has no CloudFormation resource`);
  }
  resource.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
  return construct;
}
