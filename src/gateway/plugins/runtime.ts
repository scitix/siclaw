import type { GatewayConfig } from "../config.js";

type InboundHandler = (
  channelId: string,
  chatId: string,
  senderId: string,
  text: string,
) => Promise<void>;

export interface PluginRuntime {
  channel: {
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: (...args: unknown[]) => unknown;
      finalizeInboundContext: (...args: unknown[]) => unknown;
    };
    session: {
      recordInboundSession: (...args: unknown[]) => void;
    };
  };
  config: {
    loadConfig: () => Record<string, unknown>;
  };
  logging: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
  [key: string]: unknown;
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`PluginRuntime.${name} is not implemented in siclaw gateway`);
  };
}

export function createPluginRuntime(
  config: GatewayConfig,
  onInboundMessage?: InboundHandler,
): PluginRuntime {
  const handler = onInboundMessage;

  const runtime: PluginRuntime = {
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher(...args: unknown[]) {
          // The feishu plugin calls this to dispatch inbound messages.
          // We intercept and route to our session manager.
          // args vary by plugin — extract what we can.
          if (handler) {
            const ctx = args[0] as Record<string, unknown> | undefined;
            const channelId = String(ctx?.channelId ?? ctx?.channel ?? "feishu");
            const chatId = String(ctx?.chatId ?? ctx?.chat_id ?? ctx?.conversationId ?? "unknown");
            const senderId = String(ctx?.senderId ?? ctx?.sender_id ?? ctx?.userId ?? "unknown");
            const text = String(ctx?.text ?? ctx?.content ?? ctx?.message ?? "");
            handler(channelId, chatId, senderId, text).catch((err) => {
              console.error("[runtime] inbound dispatch error:", err);
            });
          }
          return undefined;
        },
        finalizeInboundContext(..._args: unknown[]) {
          // Simplified: no-op for siclaw gateway
          return undefined;
        },
      },
      session: {
        recordInboundSession(..._args: unknown[]) {
          // No-op: we don't track channel sessions separately
        },
      },
    },
    config: {
      loadConfig() {
        return config as unknown as Record<string, unknown>;
      },
    },
    logging: {
      info: (...args: unknown[]) => console.log("[plugin-runtime]", ...args),
      warn: (...args: unknown[]) => console.warn("[plugin-runtime]", ...args),
      error: (...args: unknown[]) => console.error("[plugin-runtime]", ...args),
      debug: (...args: unknown[]) => console.debug("[plugin-runtime]", ...args),
    },
  };

  // Proxy to catch unimplemented property access at any depth
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === "symbol") {
        return undefined;
      }
      console.warn(`[plugin-runtime] Accessing unimplemented: runtime.${String(prop)}`);
      return notImplemented(`${String(prop)}`);
    },
  });
}
