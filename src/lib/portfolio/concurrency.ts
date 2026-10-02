export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(maxInFlight: number): Limiter {
  const capacity = Math.max(1, maxInFlight);
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const nextWaiter = waiting.shift();
    if (nextWaiter) nextWaiter();
    else inFlight -= 1;
  };
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (inFlight < capacity) {
        inFlight += 1;
        resolve();
      } else {
        waiting.push(resolve);
      }
    });
  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
