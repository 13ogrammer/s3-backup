import { api } from './api';

export type CollisionReport = {
  /** Total number of keys that exist in both source and destination. */
  total: number;
  /** Sample of colliding relative paths (max sampleSize, default 5). */
  samples: string[];
  /**
   * True when either side hit the page cap before the walk completed.
   * The collision count is a lower bound when truncated.
   */
  truncated: boolean;
};

const DEFAULT_SAMPLE_SIZE = 5;
const DEFAULT_MAX_PAGES = 50;

/**
 * Lists all relative paths under fromPrefix and toPrefix (paginated, up to
 * maxPages pages per side) and intersects them to find collisions.
 */
export async function detectCollisions(
  fromPrefix: string,
  toPrefix: string,
  options?: { sampleSize?: number; maxPages?: number },
): Promise<CollisionReport> {
  const sampleSize = options?.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

  async function collectRelativePaths(prefix: string): Promise<{ paths: Set<string>; truncated: boolean }> {
    const paths = new Set<string>();
    let continuationToken: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const res = await api.list({ prefix, recursive: true, continuationToken });
      for (const file of res.files) {
        // Store the path relative to the prefix so we can compare across sides.
        const rel = file.key.slice(prefix.length);
        if (rel) paths.add(rel);
      }
      continuationToken = res.nextToken;
      pages += 1;
      if (pages >= maxPages && continuationToken) {
        truncated = true;
        break;
      }
    } while (continuationToken);

    return { paths, truncated };
  }

  const [fromResult, toResult] = await Promise.all([
    collectRelativePaths(fromPrefix),
    collectRelativePaths(toPrefix),
  ]);

  const collisions: string[] = [];
  for (const rel of fromResult.paths) {
    if (toResult.paths.has(rel)) {
      collisions.push(rel);
    }
  }

  return {
    total: collisions.length,
    samples: collisions.slice(0, sampleSize),
    truncated: fromResult.truncated || toResult.truncated,
  };
}
