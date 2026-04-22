/**
 * Lightweight async mutex for serialising access to a shared resource.
 *
 * Used by the SQLite driver to prevent concurrent BEGIN/COMMIT from being
 * issued on the single underlying connection.
 */

export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => next);
    await previous;
    return release;
  }
}
