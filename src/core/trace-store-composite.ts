/**
 * CompositeTraceStore — fan-out writes to multiple TraceStore backends,
 * preferring the first one (primary) for reads.
 *
 * Used when the operator enables both SQLite and MySQL in config. Each write
 * is attempted against every backend; the composite succeeds as long as at
 * least one backend succeeded. Failed backends log a warning but don't block
 * the call — this preserves data on whichever sink survives (e.g. MySQL pod
 * restarts → local SQLite still captures the rows; SQLite fs goes read-only
 * → MySQL still takes the writes).
 *
 * Read strategy (list / getById): always hit stores[0] (the primary). If it
 * misses getById, fall through to the remaining stores so a locally-only
 * stored trace is still reachable via API after a MySQL outage.
 */

import type {
  TraceStore,
  TraceRow,
  TraceListOpts,
  TraceListResult,
  TraceRecord,
} from "./trace-store-types.js";

export interface NamedStore {
  name: string;
  store: TraceStore;
}

export class CompositeTraceStore implements TraceStore {
  constructor(private readonly stores: readonly NamedStore[]) {
    if (stores.length === 0) {
      throw new Error("CompositeTraceStore requires at least one backing store");
    }
  }

  async insert(row: TraceRow & { bodyJson: string }): Promise<void> {
    await this.fanOut("insert", row.id, (s) => s.insert(row));
  }

  async upsert(row: TraceRow & { bodyJson: string }): Promise<void> {
    await this.fanOut("upsert", row.id, (s) => s.upsert(row));
  }

  /** Primary-only read. Users expect a single consistent page, not a merge. */
  async list(opts: TraceListOpts): Promise<TraceListResult> {
    return await this.stores[0].store.list(opts);
  }

  /** Primary first, then fall through (recovers rows stranded on a secondary). */
  async getById(id: string): Promise<TraceRecord | null> {
    for (const { store } of this.stores) {
      try {
        const rec = await store.getById(id);
        if (rec) return rec;
      } catch (err) {
        console.warn(`[trace-store-composite] getById(${id}) failed on a backend:`, err);
      }
    }
    return null;
  }

  /**
   * Fan-out delete to every backend so a row removed via API does not linger
   * on a secondary sink. Returns true if any backend acknowledged a removal.
   */
  async deleteById(id: string): Promise<boolean> {
    const results = await Promise.allSettled(
      this.stores.map(({ store }) => store.deleteById(id)),
    );
    let removed = false;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (r.value) removed = true;
      } else {
        console.warn(
          `[trace-store-composite] deleteById(${id}) failed on backend "${this.stores[i].name}":`,
          r.reason,
        );
      }
    });
    return removed;
  }

  async close(): Promise<void> {
    // Close every backend even if one throws — don't leak connections.
    await Promise.allSettled(this.stores.map(({ store }) => store.close()));
  }

  /**
   * Execute `op` against every backend in parallel. If at least one succeeds,
   * this returns normally after logging warnings for the failed ones. If ALL
   * fail, throws an aggregated error — callers (the recorder) can decide
   * whether to surface or swallow.
   */
  private async fanOut(
    opName: string,
    traceKey: string,
    op: (store: TraceStore) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.all(
      this.stores.map(async ({ name, store }) => {
        try {
          await op(store);
          return { name, ok: true as const };
        } catch (err) {
          return { name, ok: false as const, err };
        }
      }),
    );
    const failed = results.filter((r): r is { name: string; ok: false; err: unknown } => !r.ok);
    if (failed.length === results.length) {
      const msg = failed.map((f) => `${f.name}: ${String(f.err)}`).join(" | ");
      throw new Error(`[trace-store-composite] all ${results.length} backends failed ${opName} for ${traceKey}: ${msg}`);
    }
    for (const f of failed) {
      console.warn(
        `[trace-store-composite] ${opName} failed on backend "${f.name}" for trace_key=${traceKey}; ` +
        `other backends succeeded. Error:`,
        f.err,
      );
    }
  }
}
