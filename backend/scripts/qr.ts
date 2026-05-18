/**
 * Retrieves the deployed API URL and bootstrap token from a live s3-backup
 * CloudFormation stack, then renders a scannable QR code in the terminal.
 *
 * The QR payload is JSON with exactly two keys:
 *   { "apiUrl": "https://...", "bootstrapToken": "..." }
 *
 * Scan the code with the "Scan QR" button in the app's Settings tab to
 * auto-fill both fields without manual copy/paste.
 *
 * Usage:
 *   npm run qr -- [--stack <name>] [--region <region>]
 *
 * Defaults:
 *   --stack   s3-backup
 *   --region  AWS_REGION env var, or the default credential-chain region
 *
 * Required IAM permissions:
 *   cloudformation:DescribeStacks
 *   cloudformation:DescribeStackResources
 *   lambda:GetFunctionConfiguration
 */

import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import qrcode from 'qrcode-terminal';

function parseArgs(argv: string[]): { stack: string; region: string | undefined } {
  const args = argv.slice(2);
  let stack = 's3-backup';
  let region: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--stack') {
      region = undefined;
      const next = args[++i];
      if (!next) {
        console.error('--stack requires a value');
        process.exit(2);
      }
      stack = next;
    } else if (a.startsWith('--stack=')) {
      stack = a.slice('--stack='.length);
    } else if (a === '--region') {
      const next = args[++i];
      if (!next) {
        console.error('--region requires a value');
        process.exit(2);
      }
      region = next;
    } else if (a.startsWith('--region=')) {
      region = a.slice('--region='.length);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }

  return { stack, region };
}

async function main() {
  const { stack, region } = parseArgs(process.argv);

  const cfn = new CloudFormationClient({ region });
  const lambda = new LambdaClient({ region });

  // --- Retrieve ApiUrl from stack outputs ---
  let apiUrl: string | undefined;
  let apiFunctionName: string | undefined;

  try {
    const stackResult = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
    const stackInfo = stackResult.Stacks?.[0];
    if (!stackInfo) {
      console.error(`Stack "${stack}" not found.`);
      process.exit(1);
    }
    apiUrl = stackInfo.Outputs?.find((o) => o.OutputKey === 'ApiUrl')?.OutputValue;
    if (!apiUrl) {
      console.error(
        `Stack "${stack}" exists but has no "ApiUrl" output. ` +
          'Has the stack finished deploying?',
      );
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('does not exist')) {
      console.error(
        `Stack "${stack}" not found. ` +
          'Run `sam deploy` first, or pass --stack <name> if your stack has a different name.',
      );
    } else {
      console.error(`Failed to describe stack "${stack}": ${msg}`);
    }
    process.exit(1);
  }

  // --- Find the ApiFn Lambda resource logical ID ---
  try {
    const resources = await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }));
    const apiFnResource = resources.StackResources?.find(
      (r) => r.LogicalResourceId === 'ApiFn',
    );
    if (!apiFnResource?.PhysicalResourceId) {
      console.error(
        `Could not find the "ApiFn" Lambda resource in stack "${stack}". ` +
          'Has the stack finished deploying?',
      );
      process.exit(1);
    }
    apiFunctionName = apiFnResource.PhysicalResourceId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to list resources for stack "${stack}": ${msg}`);
    process.exit(1);
  }

  // --- Retrieve BOOTSTRAP_TOKEN from Lambda environment ---
  let bootstrapToken: string | undefined;
  try {
    const fnConfig = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: apiFunctionName }),
    );
    bootstrapToken = fnConfig.Environment?.Variables?.['BOOTSTRAP_TOKEN'];
    if (!bootstrapToken) {
      console.error(
        `BOOTSTRAP_TOKEN environment variable is not set on function "${apiFunctionName}". ` +
          'This is unexpected — re-deploy the stack to fix it.',
      );
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read Lambda configuration for "${apiFunctionName}": ${msg}`);
    process.exit(1);
  }

  const payload = JSON.stringify({ apiUrl, bootstrapToken });

  // Security warning must appear before the QR so it's seen first.
  console.log('');
  console.log('=================================================================');
  console.log('  SECURITY WARNING');
  console.log('  The QR code below contains your bootstrap token — treat it');
  console.log('  like a password. Do not share it, screenshot it, or leave');
  console.log('  it visible on screen in a shared space.');
  console.log('=================================================================');
  console.log('');
  console.log(`Stack:   ${stack}`);
  console.log(`API URL: ${apiUrl}`);
  console.log('Token:   (hidden — encoded in QR only)');
  console.log('');

  qrcode.generate(payload, { small: true }, (qr) => {
    console.log(qr);
    console.log('Scan with the "Scan QR" button in the app\'s Settings tab.');
    console.log('');
  });
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
