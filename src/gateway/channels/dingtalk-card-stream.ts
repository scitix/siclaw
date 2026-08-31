/**
 * 钉钉 AI 卡片的单飞、latest-wins 流式更新器。
 *
 * 模型 token 到达速度远高于钉钉卡片 API 的合理更新频率。该控制器确保：
 * 1. 任意时刻最多一个更新请求在途；
 * 2. 在途期间只保留最新快照；
 * 3. 两次请求之间满足节流间隔；
 * 4. finalize 等待在途请求结束，避免旧更新覆盖最终内容。
 */
export interface DingTalkCardStreamController {
  update(content: string): void;
  finalize(content: string): Promise<boolean>;
  hasFailed(): boolean;
}

export function createDingTalkCardStreamController(options: {
  intervalMs: number;
  updateCard: (content: string) => Promise<boolean>;
  finalizeCard: (content: string) => Promise<boolean>;
}): DingTalkCardStreamController {
  const intervalMs = Math.max(250, Math.min(options.intervalMs, 10_000));
  let pendingContent: string | null = null;
  let lastSentContent = "";
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let closing = false;
  let failed = false;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    if (closing || failed || timer || inFlight || pendingContent === null) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const flush = async (): Promise<void> => {
    if (closing || failed || inFlight || pendingContent === null) return;
    const content = pendingContent;
    pendingContent = null;
    if (!content.trim() || content === lastSentContent) {
      schedule();
      return;
    }

    const current = (async () => {
      try {
        const ok = await options.updateCard(content);
        if (!ok) {
          failed = true;
          pendingContent = null;
          clearTimer();
          return;
        }
        lastSentContent = content;
        lastSentAt = Date.now();
      } catch (err) {
        failed = true;
        pendingContent = null;
        clearTimer();
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dingtalk-card] streaming update stopped after error: ${message}`);
      }
    })().finally(() => {
      if (inFlight === current) inFlight = null;
      schedule();
    });
    inFlight = current;
    await current;
  };

  return {
    update(content: string): void {
      if (closing || failed || !content.trim() || content === lastSentContent) return;
      pendingContent = content;
      schedule();
    },

    async finalize(content: string): Promise<boolean> {
      closing = true;
      pendingContent = null;
      clearTimer();
      if (inFlight) await inFlight;
      try {
        return await options.finalizeCard(content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dingtalk-card] final update failed: ${message}`);
        return false;
      }
    },

    hasFailed(): boolean {
      return failed;
    },
  };
}
