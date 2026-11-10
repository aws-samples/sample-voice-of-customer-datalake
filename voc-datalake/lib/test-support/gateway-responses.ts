/**
 * Test support: read one AWS::ApiGateway::GatewayResponse of a synthesized template by its type.
 */
import { z } from 'zod';
import type { Template } from 'aws-cdk-lib/assertions';

import { RenderedStringRecordSchema } from './cfn-render';

const GatewayResponseSchema = z.object({
  Properties: z.object({
    ResponseType: z.string(),
    StatusCode: z.string().optional(),
    // A value may embed the API id (the UNAUTHORIZED challenge's resource_metadata URL): rendered to text.
    ResponseParameters: RenderedStringRecordSchema.optional(),
    ResponseTemplates: z.record(z.string(), z.string()).optional(),
  }),
});

export type GatewayResponseProperties = z.infer<typeof GatewayResponseSchema>['Properties'];

/** The single gateway response of `type`; throws when there is none or more than one. */
export function gatewayResponseOfType(template: Template, type: string): GatewayResponseProperties {
  const found = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse'))
    .map((resource) => GatewayResponseSchema.parse(resource).Properties)
    .filter((props) => props.ResponseType === type);
  const [only] = found;
  if (only === undefined || found.length !== 1) throw new Error(`expected one ${type} gateway response, found ${found.length}`);
  return only;
}
