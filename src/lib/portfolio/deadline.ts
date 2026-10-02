export class DeadlineError extends Error {
  constructor(what: string, budgetMs: number) {
    super(`${what} exceeded its ${budgetMs}ms time budget`);
    this.name = "DeadlineError";
  }
}

export function requestBudget(
  budgetMs: number,
  what: string,
): <T>(p: Promise<T>) => Promise<T> {
  const end = Date.now() + budgetMs;
  return <T>(p: Promise<T>): Promise<T> => {
    const remaining = end - Date.now();
    if (remaining <= 0) {
      return Promise.race([
        p,
        Promise.reject(new DeadlineError(what, budgetMs)),
      ]);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DeadlineError(what, budgetMs)),
        remaining,
      );
    });
    return Promise.race([p, expiry]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
}
