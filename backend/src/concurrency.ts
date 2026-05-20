/**
 * Processes `items` with at most `limit` concurrent calls to `fn`.
 * Returns an array of results in the same order as `items`.
 * If `fn` throws, the error propagates immediately and in-flight work
 * is abandoned (outstanding Promises settle but their results are ignored).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
