export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!failed && next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }),
  );
  return results;
}

export class QueueTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`gave up waiting ${waitedMs}ms for a vendor slot`);
    this.name = "QueueTimeoutError";
  }
}

export type Limiter = <T>(
  task: () => Promise<T>,
  options?: { queueTimeoutMs?: number },
) => Promise<T>;

export function createLimiter(maxInFlight: number): Limiter {
  const capacity = Math.max(1, maxInFlight);
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const nextWaiter = waiting.shift();
    if (nextWaiter) nextWaiter();
    else inFlight -= 1;
  };
  const acquire = (queueTimeoutMs?: number) =>
    new Promise<void>((resolve, reject) => {
      if (inFlight < capacity) {
        inFlight += 1;
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grant = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      waiting.push(grant);
      if (queueTimeoutMs !== undefined) {
        timer = setTimeout(
          () => {
            const at = waiting.indexOf(grant);
            if (at === -1) return;
            waiting.splice(at, 1);
            reject(new QueueTimeoutError(queueTimeoutMs));
          },
          Math.max(0, queueTimeoutMs),
        );
      }
    });
  return async (task, options) => {
    await acquire(options?.queueTimeoutMs);
    try {
      return await task();
    } finally {
      release();
    }
  };
}
