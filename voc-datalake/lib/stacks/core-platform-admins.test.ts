/**
 * The Cognito `platform-admins` group (lib/stacks/core-auth.ts, docs/multi-workspace.md): the people who create
 * workspaces. The bootstrap custom resource puts the first admin in it when it creates the user (its handler,
 * lambda/custom_resources/admin_bootstrap.py, adds the user to every group in `GroupNames`); there is no
 * CloudFormation group attachment, which would fail every update of a deployment that deleted `admin`.
 */
import { describe, expect, it } from 'vitest';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';

describe('the platform-admins Cognito group', () => {
  const template = synthCoreTemplate();
  const groups = template.findResources('AWS::Cognito::UserPoolGroup');
  const groupId = Object.keys(groups).find((id) => groups[id]?.Properties?.GroupName === 'platform-admins');

  it('exists and grants no IAM role by itself', () => {
    expect(groupId).toBeDefined();
    expect(groups[groupId ?? '']?.Properties?.RoleArn).toBeUndefined();
  });

  it('gets the bootstrapped admin from the bootstrap, after the group exists', () => {
    const [bootstrap] = Object.values(template.findResources('Custom::AdminBootstrap'));
    expect(bootstrap?.Properties).toMatchObject({ Username: 'admin', GroupNames: ['admins', 'platform-admins'] });
    expect(bootstrap?.DependsOn).toStrictEqual(expect.arrayContaining([groupId]));
  });

  it('has no CloudFormation group attachment', () => {
    expect(Object.keys(template.findResources('AWS::Cognito::UserPoolUserToGroupAttachment'))).toStrictEqual([]);
  });
});
