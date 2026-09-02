/**
 * 钉钉 AI 卡片的单飞、latest-wins 流式更新器。
 *
 * 正文和结构化 blockList 使用独立的单飞通道：正文走 streaming API，
 * blockList 走 instances API。finalize 会等待两个通道完成，避免旧快照
 * 覆盖最终原子提交。
 */
export interface DingTalkCardStreamController {
  update(content: string): void;
  updateBlocks(blockListJson: string): void;
  finalize(content: string): Promise<boolean>;
  hasFailed(): boolean;
}

interface LatestWinsSender {
  update(value: string): void;
  close(): Promise<void>;
  hasFailed(): boolean;
}

function createLatestWinsSender(options: {
  intervalMs: number;
  label: string;
  send: (value: string) => Promise<boolean>;
  isClosing: () => boolean;
}): LatestWinsSender {
  const intervalMs = Math.max(250, Math.min(options.intervalMs, 10_000));
  let pendingValue: string | null = null;
  let lastSentValue = "";
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failed = false;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    if (options.isClosing() || failed || timer || inFlight || pendingValue === null) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const flush = async (): Promise<void> => {
    if (options.isClosing() || failed || inFlight || pendingValue === null) return;
    const value = pendingValue;
    pendingValue = null;
    if (!value.trim() || value === lastSentValue) {
      schedule();
      return;
    }

    const current = (async () => {
      try {
        const ok = await options.send(value);
        if (!ok) {
          failed = true;
          pendingValue = null;
          clearTimer();
          return;
        }
        lastSentValue = value;
        lastSentAt = Date.now();
      } catch (err) {
        failed = true;
        pendingValue = null;
        clearTimer();
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dingtalk-card] ${options.label} updates stopped after error: ${message}`);
      }
    })().finally(() => {
      if (inFlight === current) inFlight = null;
      schedule();
    });
    inFlight = current;
    await current;
  };

  return {
    update(value: string): void {
      if (options.isClosing() || failed || !value.trim() || value === lastSentValue) return;
      pendingValue = value;
      schedule();
    },

    async close(): Promise<void> {
      pendingValue = null;
      clearTimer();
      if (inFlight) await inFlight;
    },

    hasFailed(): boolean {
      return failed;
    },
  };
}

export function createDingTalkCardStreamController(options: {
  intervalMs: number;
  updateCard: (content: string) => Promise<boolean>;
  updateCardBlocks?: (blockListJson: string) => Promise<boolean>;
  finalizeCard: (content: string) => Promise<boolean>;
}): DingTalkCardStreamController {
  let closing = false;
  const contentSender = createLatestWinsSender({
    intervalMs: options.intervalMs,
    label: "streaming content",
    send: options.updateCard,
    isClosing: () => closing,
  });
  const blockSender = createLatestWinsSender({
    intervalMs: options.intervalMs,
    label: "structured blockList",
    send: options.updateCardBlocks ?? (async () => true),
    isClosing: () => closing,
  });

  return {
    update(content: string): void {
      contentSender.update(content);
    },

    updateBlocks(blockListJson: string): void {
      if (options.updateCardBlocks) blockSender.update(blockListJson);
    },

    async finalize(content: string): Promise<boolean> {
      closing = true;
      await Promise.all([contentSender.close(), blockSender.close()]);
      try {
        return await options.finalizeCard(content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dingtalk-card] final update failed: ${message}`);
        return false;
      }
    },

    hasFailed(): boolean {
      return contentSender.hasFailed();
    },
  };
}
