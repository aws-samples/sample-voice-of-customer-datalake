#!/usr/bin/env node
const { execSync } = require('child_process');
const https = require('https');

const CONCURRENT = parseInt(process.argv[2]) || 10;
const TOTAL = parseInt(process.argv[3]) || 50;

console.log('\x1b[34m=== Bedrock Load Test ===\x1b[0m');

// Get AWS config
const getStackOutput = (stackName, outputKey) => {
  try {
    return execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].Outputs[?OutputKey==\`${outputKey}\`].OutputValue' --output text`, { encoding: 'utf8' }).trim();
  } catch { return null; }
};

const CLIENT_ID = getStackOutput('VocCoreStack', 'UserPoolClientId');
const CHAT_URL = getStackOutput('VocApiStack', 'ChatStreamUrl');

if (!CLIENT_ID || !CHAT_URL) {
  console.log('❌ Could not find deployment config');
  process.exit(1);
}

// Auth
const DEPLOY_USER = process.env.VOC_TEST_USER || 'user20';
const DEPLOY_PASS = process.env.VOC_TEST_PASS || 'VocAnalytics@@2026';

const authCmd = `aws cognito-idp initiate-auth --client-id "${CLIENT_ID}" --auth-flow USER_PASSWORD_AUTH --auth-parameters 'USERNAME=${DEPLOY_USER},PASSWORD=${DEPLOY_PASS}' --no-cli-pager`;
const authResult = JSON.parse(execSync(authCmd, { encoding: 'utf8' }));
const TOKEN = authResult.AuthenticationResult.IdToken;

if (!TOKEN) {
  console.log('❌ Authentication failed');
  process.exit(1);
}

// Chat payloads
const chatPayloads = [
    'What are the top customer complaints this week?',
    'How can we improve our customer service response times?',
    'Show me urgent issues that need attention',
    'What are the most common questions from customers about shipping?',
    'What\'s the sentiment trend for delivery issues?',
    'Which source has the most negative feedback?',
    'What are the top reasons for customer churn?',
    'What are the most common issues with the product?',
    'Summarize the main problems customers are facing',
    'What are customers saying about our pricing?',
    'Any recommendations for improving our product based on customer feedback?'
];

const makeRequest = (url, options, data) => new Promise((resolve, reject) => {
  const startTime = Date.now();
  const req = https.request(url, options, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => resolve({ 
      status: res.statusCode, 
      body, 
      responseTime: Date.now() - startTime 
    }));
  });
  req.on('error', reject);
  if (data) req.write(JSON.stringify(data));
  req.end();
});

(async () => {

  console.log(`Concurrent: ${CONCURRENT}, Total: ${TOTAL}`);
  console.log('\n\x1b[33mStarting load test...\x1b[0m');

  const startTime = Date.now();
  const results = [];

  for (let i = 0; i < TOTAL; i += CONCURRENT) {
    const batch = Array.from({ length: Math.min(CONCURRENT, TOTAL - i) }, (_, j) => {
      const randomPayload = chatPayloads[Math.floor(Math.random() * chatPayloads.length)];
      const payload = {
        context: 'Time range: last 7 days',
        days: 7,
        message: randomPayload
      };
      
      return makeRequest(`${CHAT_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
      }, payload).then(({ status, body, responseTime }) => {
        const result = { id: i + j + 1, status, body, responseTime };
        console.log(`${result.id},${result.status}`);
        return result;
      });
    });
    
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }

  const totalTime = (Date.now() - startTime) / 1000;
  const success = results.filter(r => r.status === 200).length;
  const throttled = results.filter(r => r.status === 429).length;
  const responseTimes = results.map(r => r.responseTime);
  const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  const rps = results.length / totalTime;

  console.log('\n\x1b[34mResults:\x1b[0m');
  console.log(`Total time: ${totalTime.toFixed(1)}s`);
  console.log(`Requests/sec: ${rps.toFixed(1)}`);
  console.log(`Avg response time: ${avgResponseTime.toFixed(0)}ms`);
  console.log(`Min/Max response time: ${Math.min(...responseTimes)}ms / ${Math.max(...responseTimes)}ms`);
  console.log(`Responses: ${results.length}/${TOTAL}`);
  console.log(`Success: \x1b[32m${success}\x1b[0m (${(success/results.length*100).toFixed(1)}%)`);
  console.log(`Throttled: \x1b[31m${throttled}\x1b[0m (${(throttled/results.length*100).toFixed(1)}%)`);

  if (throttled > 0) {
    console.log('\n\x1b[33mThrottling samples:\x1b[0m');
    results.filter(r => r.status === 429).slice(0, 3).forEach(r => 
      console.log(`${r.id},${r.status},${r.body}`)
    );
  }

  console.log('\n\x1b[32mComplete\x1b[0m');
})().catch(console.error);
