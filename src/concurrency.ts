export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximumConcurrency: number) {
    if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new RangeError("Maximum concurrency must be a positive integer");
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.maximumConcurrency) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  maximumConcurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
    throw new RangeError("Maximum concurrency must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  };
  const workerCount = Math.min(maximumConcurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
