## Summary

Optimizes Lambda deployment bundles so each API Lambda only includes the code it needs, rather than bundling all handlers together.

## Problem

Previously, all API Lambda functions shared a single code bundle containing every handler file:

```
lambda-deployment.zip
├── metrics_handler.py
├── chat_handler.py
├── integrations_handler.py
├── scrapers_handler.py
├── settings_handler.py
├── projects_handler.py
├── ... (all other API handlers)
└── shared/
```

This meant each Lambda had large amounts of unused code, increasing deployment size and cold start times.

## Solution

Introduced a `createApiLambdaCode()` helper function that creates optimized bundles per Lambda:

```typescript
const createApiLambdaCode = (handlerFileName: string): lambda.Code => {
  return lambda.Code.fromAsset('lambda', {
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      command: [
        'bash', '-c',
        `mkdir -p /asset-output && ` +
        `cp /asset-input/api/${handlerFileName} /asset-output/ && ` +
        `cp -r /asset-input/shared /asset-output/`
      ],
      platform: 'linux/arm64',
    },
  });
};
```

Now each Lambda receives only:
- Its specific handler file (e.g., `metrics_handler.py`)
- The `shared/` directory with common modules

## Changes

- Replaced shared `apiCodeWithShared` variable with `createApiLambdaCode()` helper
- Updated all 14 API Lambda functions to use optimized individual bundles

## Testing

- TypeScript compilation passes
- All existing tests pass

Closes #1
