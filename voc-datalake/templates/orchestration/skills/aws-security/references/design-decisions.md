# AWS Security: Design Decisions

Why each rule exists, told through the incidents that motivated them.

## No Lambda Function URLs with AuthType NONE

**Rule**: Never create Lambda Function URLs with `AuthType: NONE`.

**Battle story**: A developer created a Lambda Function URL for a health check endpoint, setting AuthType to NONE for simplicity. A security scanner flagged it as world-accessible. Before the team could remediate, the function was discovered via DNS enumeration and hit with 2M requests in one hour, costing $400 in Lambda invocations. The health check also leaked internal service names in its response.

**How to apply**: Use API Gateway with JWT authorizer or IAM auth. For internal health checks, use ALB health check targets, not public Lambda URLs.

## No IAM Principal "*"

**Rule**: Never add Lambda resource-based policies with `Principal: "*"`.

**Battle story**: A CDK construct added a resource-based policy with `Principal: "*"` to allow cross-account invocation. The developer intended to restrict via conditions but forgot the `Condition` block. Any AWS account could invoke the Lambda, which had read access to a DynamoDB table with customer data. The issue persisted for 3 weeks before a security review caught it.

**How to apply**: Use specific service principals (`lambda.amazonaws.com`, `apigateway.amazonaws.com`) with `SourceArn` conditions. For cross-account, use specific account IDs.

## No S3 Public Access

**Rule**: All S3 buckets must have `block_public_access=BLOCK_ALL`.

**Battle story**: An S3 bucket hosting static assets was configured with public-read ACL. A developer accidentally uploaded a `.env` file to the bucket during a deployment script error. The file contained database credentials. The bucket was indexed by GrayhatWarfare (S3 scanner) within hours.

**How to apply**: Set `block_public_access=BLOCK_ALL` on every bucket. For public content, use CloudFront with OAC (Origin Access Control), not direct S3 public access.

## No CORS allow_origins=["*"]

**Rule**: Always list specific allowed origins.

**Battle story**: Same pattern as the application-level CORS incident, but in API Gateway configuration. A CDK stack set `allow_origins=["*"]` for development and it was promoted to production unchanged. The API accepted authenticated requests from any origin, enabling a credential-stealing attack via a malicious site.

**How to apply**: Use environment-gated CORS origins: `["http://localhost:3000"]` for dev, `["https://app.example.com"]` for production. Never use wildcards.

## Resource-Based Policies Persist After URL Deletion

**Rule**: When removing a Lambda Function URL, also remove leftover resource-based policies.

**Battle story**: A team deleted a Lambda Function URL to address a security scanner's finding. The Function URL was gone, but the resource-based policy statement (`FunctionURLAllowPublicAccess`) persisted. The Lambda was still invocable by anyone with the invoke API, just not via the vanity URL. The finding reappeared because the underlying permission was unchanged.

**How to apply**: After deleting a Function URL, run `aws lambda get-policy --function-name <name>` and remove any statement with `Condition.StringEquals.lambda:FunctionUrlAuthType: NONE`.

## Environment-Gated Removal Policies

**Rule**: Every DESTROY removal policy must be gated on environment.

**Battle story**: A CDK stack used `RemovalPolicy.DESTROY` on a DynamoDB table for easy cleanup during development. The same stack was deployed to production without changing the removal policy. During a stack update that renamed the table's logical ID, CloudFormation deleted the production table with 2 years of data. Recovery required restoring from a point-in-time backup, causing 4 hours of downtime.

**How to apply**: Pattern: `RemovalPolicy.DESTROY if env == "dev" else RemovalPolicy.RETAIN`. Add `point_in_time_recovery=True` on all DynamoDB tables.

## Document Every Resource: "*"

**Rule**: Every `Resource: "*"` must have a comment explaining why.

**Battle story**: An IAM policy for a monitoring Lambda used `Resource: "*"` on `cloudwatch:PutMetricData`. This is actually correct (CloudWatch PutMetricData does not support resource-level permissions). However, during a security audit, the reviewer couldn't tell if this was intentional or lazy, and spent 2 hours investigating. Adding a comment (`# CloudWatch PutMetricData does not support resource-level permissions per AWS docs`) would have saved that time.

**How to apply**: For every `Resource: "*"`, add an inline comment citing the AWS documentation reason. Common exceptions: CloudWatch PutMetricData, CloudWatch Logs (CreateLogGroup), STS AssumeRole (when using global endpoint).

## Secrets Manager Over Environment Variables

**Rule**: Store secrets in Secrets Manager or SSM Parameter Store, not Lambda environment variables.

**Battle story**: A Lambda function stored an API key in an environment variable. The key was visible in the Lambda console to anyone with `lambda:GetFunctionConfiguration` permission, which was granted to the entire dev team via a broad IAM policy. A developer's laptop was compromised, giving the attacker read access to all Lambda configs and every secret stored as an environment variable.

**How to apply**: Store secrets in Secrets Manager with `aws_secretsmanager.Secret`. Grant the Lambda execution role `secretsmanager:GetSecretValue` scoped to the specific secret ARN. Read at runtime with caching.

## Global Inference Profiles: Three Scoped Statements, Not a Bare Wildcard

**Rule**: Grant Bedrock global cross-Region inference with three conditioned IAM statements, not `Resource: "*"`.

**Battle story**: A reviewer found `Resource: "*"` on `bedrock:InvokeModel` justified in a comment as "required for global inference profiles." AWS's own global cross-Region inference policy uses the opposite pattern: the global foundation-model ARN has an empty region field (`arn:aws:bedrock:::foundation-model/<model-id>`), and access is scoped with `aws:RequestedRegion` and `bedrock:InferenceProfileArn` conditions across three statements (inference-profile ARN, in-region model ARN, global model ARN). A flat `*` grants every model in every region, which the documented pattern never requires.

**How to apply**: Copy the three-statement policy from the AWS Bedrock global cross-Region inference guide. Never collapse it to a wildcard resource for convenience.
