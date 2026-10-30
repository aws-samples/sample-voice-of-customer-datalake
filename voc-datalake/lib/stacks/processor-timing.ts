/**
 * The feedback processor's timing, shared by the queue (VocIngestionStack) and the function that consumes it
 * (VocProcessingStack), so the two cannot drift apart.
 *
 * AWS Lambda's SQS guidance: set the source queue's visibility timeout to at least six times the function
 * timeout, plus the batching window (https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html).
 * The extra time lets Lambda retry a batch it could not invoke (throttling) before the messages reappear;
 * a visibility timeout close to the function timeout makes a throttled batch count against maxReceiveCount
 * and reach the DLQ early. lib/app-template-gates.test.ts holds every SQS event source of the app to this.
 */
import * as cdk from 'aws-cdk-lib';

/** The processor's ceiling: a batch of 10 records, each enriched by Bedrock + Comprehend + Translate. */
export const PROCESSOR_TIMEOUT = cdk.Duration.minutes(5);

/** Gathers a burst into one invocation; small because it adds directly to time-to-visible (QA 2.13.00). */
export const PROCESSOR_BATCHING_WINDOW = cdk.Duration.seconds(5);

/** 6 x timeout + batching window = 1,805 s. */
export const PROCESSING_QUEUE_VISIBILITY_TIMEOUT = cdk.Duration.seconds(
  6 * PROCESSOR_TIMEOUT.toSeconds() + PROCESSOR_BATCHING_WINDOW.toSeconds(),
);
