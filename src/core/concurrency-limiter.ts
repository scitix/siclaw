/**
 * A minimal counting semaphore for bounding in-process concurrency (no deps).
 *
 * Used to cap how many sub-agent child sessions run at once within a single
 * AgentBox (design §6 fan-out): pi executes a whole tool-call batch via
 * `Promise.all` with no limit, so without this an N-target fan-out would spin up
 * N concurrent child agents + N LLM streams from one pod. `run()` queues callers
 * past the limit and releases the next when a slot frees — FIFO, and the slot is
 * always released even if the task throws.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** Effective limit (>=1). A non-positive/NaN input is treated as 1. */
  readonly limit: number;

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  }

  /** Tasks currently running (occupying a slot). */
  get activeCount(): number {
    return this.active;
  }

  /** Tasks waiting for a slot (all slots busy). */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** True when a new run() would have to wait for a slot. */
  get atCapacity(): boolean {
    return this.active >= this.limit;
  }

  /** Run `task` once a slot is free; resolves/rejects with the task's result. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
