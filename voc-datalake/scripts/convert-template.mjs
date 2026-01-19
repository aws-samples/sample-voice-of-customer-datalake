/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────────
// File I/O Utilities
// ─────────────────────────────────────────────────────────────────────────────

const readJSON = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    console.error(err);
    console.error(`Unable to read JSON file ${path}`);
  }
};

const writeJSON = async (content, path) => {
  try {
    await writeFile(path, JSON.stringify(content, null, 2));
  } catch (err) {
    console.error(err);
    console.error(`Unable to write JSON file ${path}`);
  }
};

const ensureDir = (dir) => mkdir(dir, { recursive: true });

const cleanDir = async (dir) => {
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      await rm(join(dir, entry), { recursive: true, force: true });
    }
  } else {
    await ensureDir(dir);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Asset Processing
// ─────────────────────────────────────────────────────────────────────────────

const processFileAssets = async (assets, basePath, assetsOutDir) => {
  for (const file of Object.values(assets.files)) {
    const { packaging, path: srcPath } = file.source;
    if (packaging !== 'zip' && packaging !== 'file') continue;
    if (packaging === 'file' && !srcPath.endsWith('.tar') && !srcPath.endsWith('.zip')) continue;

    const destKey = getDestinationKey(file.destinations);
    if (!destKey) {
      console.error(`No destination key found for asset: ${JSON.stringify(file)}`);
      continue;
    }

    const fileName = file.destinations[destKey].objectKey;
    const assetPath = join(basePath, srcPath);

    try {
      await ensureDir(assetsOutDir);

      if (packaging === 'zip') {
        console.log(`Running: zip -r ${fileName} ./ (in ${assetPath})`);
        execSync(`zip -r ${fileName} ./`, { cwd: assetPath, stdio: 'inherit' });
        await rename(resolve(assetPath, fileName), resolve(assetsOutDir, fileName));
      } else {
        console.log(`Copying file asset: ${fileName}`);
        execSync(`cp "${join(basePath, srcPath)}" "${resolve(assetsOutDir, fileName)}"`, { stdio: 'inherit' });
        console.log(`✓ Copied file asset to ${resolve(assetsOutDir, fileName)}`);
      }
    } catch (err) {
      console.error(err);
      console.error(`Failed to process ${packaging} asset ${fileName}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Template Transformation Helpers
// ─────────────────────────────────────────────────────────────────────────────

const getDestinationKey = (destinations) => {
  const keys = Object.keys(destinations || {});
  return keys.find((k) => k.startsWith('current_account-')) || keys[0];
};

const createS3KeyRef = (originalKey) => ({
  'Fn::Sub': [`\${Prefix}${originalKey}`, { Prefix: { Ref: 'AssetPrefix' } }],
});

const cleanTemplateMetadata = (template) => {
  delete template.Rules;
  delete template.Parameters?.BootstrapVersion;
  delete template.Resources?.Metadata;
  delete template.Resources?.CDKMetadata;
  delete template.Conditions?.CDKMetadataAvailable;

  for (const resource of Object.values(template.Resources)) {
    delete resource.Metadata;
  }
};

const addAssetParameters = (template) => {
  template.Parameters.AssetBucket = {
    Type: 'String',
    Description: 'Name of the Amazon S3 Bucket where the assets related to this stack will be found.',
  };
  template.Parameters.AssetPrefix = {
    Type: 'String',
    Description: 'Prefix of the Amazon S3 Bucket where the assets related to this stack are.',
  };
};

const updateLambdaS3References = (template) => {
  for (const resource of Object.values(template.Resources)) {
    const { Type, Properties } = resource;

    if (Type === 'AWS::Lambda::LayerVersion') {
      Properties.Content.S3Bucket = { Ref: 'AssetBucket' };
      Properties.Content.S3Key = createS3KeyRef(Properties.Content.S3Key);
    } else if (Type === 'AWS::Lambda::Function' && !Properties.Code?.ZipFile) {
      Properties.Code.S3Bucket = { Ref: 'AssetBucket' };
      Properties.Code.S3Key = createS3KeyRef(Properties.Code.S3Key);
    }
  }
};

const updateIAMPolicies = (template) => {
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') continue;

    const statements = resource.Properties?.PolicyDocument?.Statement;
    if (!Array.isArray(statements)) continue;

    for (const statement of statements) {
      const actions = statement.Action || [];
      const hasS3Get = actions.includes('s3:GetObject') || actions.includes('s3:GetObjectVersion');

      if (hasS3Get && typeof statement.Resource === 'string' &&
          statement.Resource.includes('arn:aws:s3:::') && statement.Resource.includes('.tar')) {
        statement.Resource = {
          'Fn::Sub': ['arn:aws:s3:::${Bucket}/${Prefix}*', {
            Bucket: { Ref: 'AssetBucket' },
            Prefix: { Ref: 'AssetPrefix' },
          }],
        };
      }
    }
  }
};

const updateBucketDeployment = (template) => {
  for (const [key, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'Custom::CDKBucketDeployment') continue;

    const props = resource.Properties;
    props.SourceBucketNames?.forEach((_, i) => {
      props.SourceBucketNames[i] = { Ref: 'AssetBucket' };
    });
    props.SourceObjectKeys?.forEach((key, i) => {
      props.SourceObjectKeys[i] = createS3KeyRef(key);
    });

    // Update associated IAM policy
    const policyKey = Object.keys(template.Resources).findLast(
      (k) => k.startsWith('CustomCDKBucketDeployment') && template.Resources[k].Type === 'AWS::IAM::Policy'
    );
    if (policyKey) {
      template.Resources[policyKey].Properties.PolicyDocument.Statement[0].Resource = [
        { 'Fn::Sub': ['arn:aws:s3:::${AssetBucket}', { AssetBucket: { Ref: 'AssetBucket' } }] },
        { 'Fn::Sub': ['arn:aws:s3:::${AssetBucket}/${AssetPrefix}*', {
          AssetBucket: { Ref: 'AssetBucket' },
          AssetPrefix: { Ref: 'AssetPrefix' },
        }]},
      ];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Hardcoded Value Replacement
// ─────────────────────────────────────────────────────────────────────────────

const detectRegionAndAccount = (templateStr) => {
  const accountMatches = templateStr.match(/\d{12}/g) || [];
  const accountCounts = accountMatches.reduce((acc, id) => ({ ...acc, [id]: (acc[id] || 0) + 1 }), {});
  const account = Object.entries(accountCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

  const regionMatch = templateStr.match(/(eu-west-\d|us-east-\d|us-west-\d|ap-southeast-\d|ap-northeast-\d|eu-central-\d|ap-south-\d|sa-east-\d|ca-central-\d)/);

  return { region: regionMatch?.[1], account };
};

const replaceHardcodedValues = (obj, region, accountId, parentKey = '', isInFnJoin = false) => {
  if (typeof obj === 'string') {
    if (/[a-f0-9]{64}\.zip/.test(obj)) return obj; // Skip asset hashes

    if (parentKey === 'AvailabilityZone' && obj.match(new RegExp(`${region}[a-z]`))) {
      const azIndex = obj.replace(region, '').charCodeAt(0) - 97;
      return { 'Fn::Select': [azIndex, { 'Fn::GetAZs': { Ref: 'AWS::Region' } }] };
    }

    let result = obj;
    if (result.includes(accountId)) result = result.replace(new RegExp(accountId, 'g'), '${AWS::AccountId}');
    if (result.includes(region) && !result.match(new RegExp(`${region}[a-z]`))) {
      result = result.replace(new RegExp(region, 'g'), '${AWS::Region}');
    }

    if (result === obj) return obj;
    if (result === '${AWS::AccountId}') return { Ref: 'AWS::AccountId' };
    if (result === '${AWS::Region}') return { Ref: 'AWS::Region' };
    if (result.includes('${AWS::') && parentKey !== 'Fn::Sub') return { 'Fn::Sub': result };
    return result;
  }

  if (Array.isArray(obj)) {
    const isFnJoinArray = parentKey === 'Fn::Join';
    return obj.map((item, idx) => replaceHardcodedValues(item, region, accountId, parentKey, isFnJoinArray && idx === 1));
  }

  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, replaceHardcodedValues(value, region, accountId, key, isInFnJoin)])
    );
  }

  return obj;
};

const fixFnJoinStrings = (obj, parentKey = '', inFnJoin = false, grandparentKey = '') => {
  if (typeof obj === 'string' && inFnJoin) {
    const parts = [];
    let current = obj;
    const patterns = [
      { pattern: '${AWS::Region}', ref: 'AWS::Region' },
      { pattern: '${AWS::AccountId}', ref: 'AWS::AccountId' },
    ];

    while (current) {
      let earliest = { idx: -1, pattern: null };
      for (const p of patterns) {
        const idx = current.indexOf(p.pattern);
        if (idx >= 0 && (earliest.idx < 0 || idx < earliest.idx)) {
          earliest = { idx, ...p };
        }
      }

      if (earliest.idx < 0) {
        if (current) parts.push(current);
        break;
      }

      if (earliest.idx > 0) parts.push(current.substring(0, earliest.idx));
      parts.push({ Ref: earliest.ref });
      current = current.substring(earliest.idx + earliest.pattern.length);
    }

    return parts.length > 1 ? parts : obj;
  }

  if (Array.isArray(obj)) {
    const mapped = obj.map((item) => fixFnJoinStrings(item, parentKey, inFnJoin, grandparentKey));
    return inFnJoin ? mapped.flat() : mapped;
  }

  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'Fn::Join' && Array.isArray(value) && value.length === 2) {
        result[key] = [value[0], fixFnJoinStrings(value[1], key, true, parentKey)];
      } else if (key === 'Value' && grandparentKey === 'Outputs') {
        if (typeof value === 'string' && value.includes('${AWS::')) {
          result[key] = { 'Fn::Sub': value };
        } else if (Array.isArray(value)) {
          result[key] = { 'Fn::Join': ['', value] };
        } else {
          result[key] = fixFnJoinStrings(value, key, false, parentKey);
        }
      } else {
        result[key] = fixFnJoinStrings(value, key, false, parentKey);
      }
    }
    return result;
  }

  return obj;
};

const removeIntrinsicDefaults = (template) => {
  for (const param of Object.values(template.Parameters)) {
    if (param.Default && typeof param.Default === 'object') delete param.Default;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  const [stackName] = process.argv.slice(2);
  if (!stackName) {
    console.error('Please provide a stack name as an argument\n e.g. node scripts/convert-template.mjs [stack-name]');
    process.exit(1);
  }

  console.log(`Converting template for stack ${stackName}`);

  const currentDir = process.cwd();
  const basePath = resolve(currentDir, 'cdk.out');
  const templatesOutDir = resolve(currentDir, 'Workshop', 'static', 'cfn');
  const assetsOutDir = resolve(currentDir, 'Workshop', 'assets', stackName);

  // Load template and assets
  const template = await readJSON(join(basePath, `${stackName}.template.json`));
  const assets = await readJSON(join(basePath, `${stackName}.assets.json`));

  if (!template || !assets) {
    console.error('Failed to load template or assets; aborting');
    process.exit(1);
  }

  // Prepare output directories
  if (!existsSync(templatesOutDir)) await ensureDir(templatesOutDir);
  await cleanDir(assetsOutDir);

  // Process assets
  await processFileAssets(assets, basePath, assetsOutDir);

  // Transform template
  cleanTemplateMetadata(template);
  addAssetParameters(template);
  updateLambdaS3References(template);
  updateIAMPolicies(template);
  updateBucketDeployment(template);

  // Replace hardcoded region/account
  const { region, account } = detectRegionAndAccount(JSON.stringify(template));

  if (!region || !account) {
    console.warn('Warning: Could not detect region or account. Skipping replacements.');
  } else {
    console.log(`Detected region: ${region}, account: ${account}`);
    console.log('Replacing hardcoded values with pseudo-parameters...');
  }

  let finalTemplate = region && account ? replaceHardcodedValues(template, region, account) : template;
  finalTemplate = fixFnJoinStrings(finalTemplate);
  removeIntrinsicDefaults(finalTemplate);

  // Write output
  const outPath = resolve(templatesOutDir, `${stackName}.json`);
  await writeJSON(finalTemplate, outPath);

  console.log(`Template for stack ${stackName} converted successfully.`);
  console.log(`- Template: ${outPath}`);
  console.log(`- Assets folder: ${assetsOutDir}`);
};

main();
