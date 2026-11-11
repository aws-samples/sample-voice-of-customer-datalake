/**
 * The Cognito `platform-admins` group (lib/stacks/core-auth.ts, docs/multi-workspace.md): the people who create
 * workspaces. The bootstrapped `admin` is put in it by a CloudFormation attachment, created only after the bootstrap
 * custom resource made the user and after the group exists.
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

  it('gets the bootstrapped admin, after the group and the bootstrap', () => {
    const attachments = Object.values(template.findResources('AWS::Cognito::UserPoolUserToGroupAttachment'));
    expect(attachments).toHaveLength(1);
    const attachment = attachments[0];
    expect(attachment?.Properties).toMatchObject({ GroupName: 'platform-admins', Username: 'admin' });
    const bootstrapId = Object.keys(template.findResources('Custom::AdminBootstrap'))[0];
    expect(attachment?.DependsOn).toStrictEqual(expect.arrayContaining([groupId, bootstrapId]));
  });
});
