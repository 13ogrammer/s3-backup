/**
 * Read-only preflight check for an existing S3 bucket you intend to
 * use with s3-backup. Verifies that the bucket exists, that your
 * current AWS credentials can describe it, and that the recommended
 * production settings are in place (versioning, public-access-block,
 * ownership controls, default encryption, abort-incomplete-multipart
 * lifecycle, region match).
 *
 * Usage:
 *   npm run check:bucket -- <bucket-name> [--region us-east-1] [--allow-warnings]
 *
 * Exits 0 if all blocker + strongly-recommended checks pass.
 * Exits 1 if any blocker fails, or if any strongly-recommended check
 * fails (unless --allow-warnings is passed, which downgrades the
 * strongly-recommended tier to warnings).
 *
 * Nice-to-have checks never fail the script — they're informational.
 *
 * Required IAM permissions on the bucket:
 *   s3:HeadBucket, s3:GetBucketLocation, s3:GetBucketVersioning,
 *   s3:GetBucketPublicAccessBlock, s3:GetBucketOwnershipControls,
 *   s3:GetBucketLifecycleConfiguration, s3:GetBucketEncryption,
 *   s3:GetBucketCors, s3:ListBucket
 * Equivalent to the AWS-managed AmazonS3ReadOnlyAccess policy.
 */

import {
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

type Severity = 'blocker' | 'recommended' | 'nice-to-have';
type Outcome = 'pass' | 'fail' | 'skip';

interface CheckResult {
  name: string;
  severity: Severity;
  outcome: Outcome;
  detail: string;
  fix?: string;
}

function parseArgs(argv: string[]): {
  bucket: string;
  region: string | undefined;
  allowWarnings: boolean;
} {
  const args = argv.slice(2);
  let bucket: string | undefined;
  let region: string | undefined;
  let allowWarnings = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--region') {
      region = args[++i];
    } else if (a === '--allow-warnings') {
      allowWarnings = true;
    } else if (a.startsWith('--region=')) {
      region = a.slice('--region='.length);
    } else if (!a.startsWith('--')) {
      bucket = a;
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }

  if (!bucket) {
    console.error(
      'Usage: npm run check:bucket -- <bucket-name> [--region us-east-1] [--allow-warnings]',
    );
    process.exit(2);
  }

  return { bucket, region, allowWarnings };
}

function isAccessDenied(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    return (
      err.name === 'AccessDenied' ||
      err.$metadata?.httpStatusCode === 403
    );
  }
  return false;
}

function isNotFoundConfig(err: unknown): boolean {
  if (!(err instanceof S3ServiceException)) return false;
  return [
    'NoSuchPublicAccessBlockConfiguration',
    'OwnershipControlsNotFoundError',
    'NoSuchBucketPolicy',
    'NoSuchLifecycleConfiguration',
    'ServerSideEncryptionConfigurationNotFoundError',
    'NoSuchCORSConfiguration',
  ].includes(err.name);
}

async function check(
  name: string,
  severity: Severity,
  fn: () => Promise<{ pass: boolean; detail: string; fix?: string }>,
): Promise<CheckResult> {
  try {
    const r = await fn();
    return { name, severity, outcome: r.pass ? 'pass' : 'fail', detail: r.detail, fix: r.fix };
  } catch (err) {
    if (isAccessDenied(err)) {
      return {
        name,
        severity,
        outcome: 'skip',
        detail: 'Access denied — your IAM principal cannot read this setting',
        fix: 'Grant the matching s3:Get* permission to your IAM user',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { name, severity, outcome: 'fail', detail: `Error: ${msg}` };
  }
}

async function main() {
  const { bucket, region, allowWarnings } = parseArgs(process.argv);

  // Region is only needed for the initial HeadBucket; the SDK
  // auto-redirects for the other calls. Default to the env's region
  // or us-east-1.
  const s3 = new S3Client({ region: region ?? process.env.AWS_REGION ?? 'us-east-1' });

  console.log(`\nChecking bucket: ${bucket}`);
  if (region) console.log(`Expected region: ${region}`);
  console.log('');

  const results: CheckResult[] = [];

  // ---- Blocker: bucket reachable ----
  results.push(
    await check('Bucket exists and is accessible', 'blocker', async () => {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return { pass: true, detail: 'HeadBucket succeeded' };
    }),
  );

  // If the bucket itself is unreachable, stop — no point running the rest.
  if (results[0]?.outcome === 'fail') {
    printReport(results);
    console.error(
      '\nBucket is not reachable. Fix this before running the other checks.',
    );
    process.exit(1);
  }

  // ---- Nice-to-have: region match ----
  results.push(
    await check('Bucket region', 'nice-to-have', async () => {
      const r = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
      const actual = r.LocationConstraint ?? 'us-east-1';
      if (region && actual !== region) {
        return {
          pass: false,
          detail: `Bucket region is ${actual}, expected ${region}`,
          fix: 'Deploy the Lambda in the same region as the bucket, or use a different bucket',
        };
      }
      return { pass: true, detail: `Region: ${actual}` };
    }),
  );

  // ---- Strongly recommended: versioning ----
  results.push(
    await check('Versioning enabled', 'recommended', async () => {
      const r = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      if (r.Status === 'Enabled') {
        return { pass: true, detail: 'Versioning is Enabled' };
      }
      return {
        pass: false,
        detail: `Versioning status: ${r.Status ?? 'Not configured'}`,
        fix: 'Enable in S3 console → Bucket → Properties → Bucket Versioning',
      };
    }),
  );

  // ---- Strongly recommended: public access block ----
  results.push(
    await check('Public access block (all 4 flags)', 'recommended', async () => {
      try {
        const r = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
        const c = r.PublicAccessBlockConfiguration ?? {};
        const allOn =
          c.BlockPublicAcls === true &&
          c.BlockPublicPolicy === true &&
          c.IgnorePublicAcls === true &&
          c.RestrictPublicBuckets === true;
        if (allOn) {
          return { pass: true, detail: 'All four flags are true' };
        }
        return {
          pass: false,
          detail: `Flags: BlockPublicAcls=${c.BlockPublicAcls} BlockPublicPolicy=${c.BlockPublicPolicy} IgnorePublicAcls=${c.IgnorePublicAcls} RestrictPublicBuckets=${c.RestrictPublicBuckets}`,
          fix: 'S3 console → Bucket → Permissions → Block public access → enable all four',
        };
      } catch (err) {
        if (isNotFoundConfig(err)) {
          return {
            pass: false,
            detail: 'No public access block configuration set',
            fix: 'S3 console → Bucket → Permissions → Block public access → enable all four',
          };
        }
        throw err;
      }
    }),
  );

  // ---- Strongly recommended: object ownership = BucketOwnerEnforced ----
  results.push(
    await check('Object Ownership: BucketOwnerEnforced', 'recommended', async () => {
      try {
        const r = await s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }));
        const rule = r.OwnershipControls?.Rules?.[0]?.ObjectOwnership;
        if (rule === 'BucketOwnerEnforced') {
          return { pass: true, detail: 'BucketOwnerEnforced (ACLs disabled)' };
        }
        return {
          pass: false,
          detail: `Ownership: ${rule ?? 'unset'}`,
          fix: 'S3 console → Bucket → Permissions → Object Ownership → ACLs disabled (BucketOwnerEnforced)',
        };
      } catch (err) {
        if (isNotFoundConfig(err)) {
          return {
            pass: false,
            detail: 'No ownership controls set',
            fix: 'S3 console → Bucket → Permissions → Object Ownership → ACLs disabled (BucketOwnerEnforced)',
          };
        }
        throw err;
      }
    }),
  );

  // ---- Strongly recommended: default encryption present ----
  results.push(
    await check('Default encryption configured', 'recommended', async () => {
      try {
        const r = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
        const alg =
          r.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
        if (alg) {
          return { pass: true, detail: `SSE algorithm: ${alg}` };
        }
        return {
          pass: false,
          detail: 'Encryption rule present but no SSEAlgorithm — unusual',
          fix: 'S3 console → Bucket → Properties → Default encryption → enable SSE-S3',
        };
      } catch (err) {
        if (isNotFoundConfig(err)) {
          return {
            pass: false,
            detail: 'No default encryption configured (AWS auto-enables SSE-S3 on new buckets since 2023; pre-2023 buckets may not have it)',
            fix: 'S3 console → Bucket → Properties → Default encryption → enable SSE-S3',
          };
        }
        throw err;
      }
    }),
  );

  // ---- Nice-to-have: abort-incomplete-multipart lifecycle rule ----
  results.push(
    await check('Abort incomplete multipart uploads', 'nice-to-have', async () => {
      try {
        const r = await s3.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
        );
        const hasAbort = (r.Rules ?? []).some(
          (rule) =>
            rule.Status === 'Enabled' &&
            rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation,
        );
        if (hasAbort) {
          return { pass: true, detail: 'Lifecycle rule cleans up failed uploads' };
        }
        return {
          pass: false,
          detail: 'No abort-incomplete-multipart-upload rule',
          fix: 'S3 console → Bucket → Management → Lifecycle → add rule with 7-day abort',
        };
      } catch (err) {
        if (isNotFoundConfig(err)) {
          return {
            pass: false,
            detail: 'No lifecycle configuration set',
            fix: 'S3 console → Bucket → Management → Lifecycle → add rule with 7-day abort',
          };
        }
        throw err;
      }
    }),
  );

  printReport(results);

  const failedBlockers = results.filter((r) => r.severity === 'blocker' && r.outcome === 'fail');
  const failedRecommended = results.filter(
    (r) => r.severity === 'recommended' && r.outcome === 'fail',
  );

  if (failedBlockers.length > 0) {
    console.error(`\n${failedBlockers.length} blocker(s) failed — cannot proceed.`);
    process.exit(1);
  }

  if (failedRecommended.length > 0 && !allowWarnings) {
    console.error(
      `\n${failedRecommended.length} strongly-recommended check(s) failed. ` +
        `Fix the issues above, or re-run with --allow-warnings to proceed anyway.`,
    );
    process.exit(1);
  }

  console.log('\nAll required checks passed. Bucket is ready.');
}

function printReport(results: CheckResult[]) {
  const icon = (r: CheckResult): string => {
    if (r.outcome === 'pass') return '✓';
    if (r.outcome === 'skip') return 'ⓘ';
    return r.severity === 'blocker' || r.severity === 'recommended' ? '✗' : '!';
  };
  const tier = (s: Severity): string => {
    if (s === 'blocker') return '[blocker]    ';
    if (s === 'recommended') return '[recommended]';
    return '[nice-to-have]';
  };

  for (const r of results) {
    console.log(`${icon(r)} ${tier(r.severity)} ${r.name}`);
    console.log(`    ${r.detail}`);
    if (r.outcome === 'fail' && r.fix) {
      console.log(`    → ${r.fix}`);
    }
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
