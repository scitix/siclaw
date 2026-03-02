import type { GatewayConfig } from "../config.js";
import type { PluginRuntime } from "./runtime.js";

/** Card handle returned by createCard, used for subsequent updates */
export interface StreamingCard {
  cardId: string;
  title?: string;
  [key: string]: unknown;
}

/** Image data for sending */
export interface ImageData {
  data: string; // base64 encoded
  mimeType: string; // e.g., "image/png", "image/jpeg"
  filename?: string;
}

/** File data for sending */
export interface FileData {
  data: string; // base64 encoded
  mimeType: string;
  filename: string;
}

/** Audio data for sending */
export interface AudioData {
  data: string; // base64 encoded
  mimeType: string; // e.g., "audio/ogg", "audio/mp3"
  duration?: number; // duration in seconds
  filename?: string;
}

/** Video data for sending */
export interface VideoData {
  data: string; // base64 encoded
  mimeType: string;
  duration?: number;
  width?: number;
  height?: number;
  thumbnail?: string; // base64 encoded thumbnail
  filename?: string;
}

/** Link message data */
export interface LinkData {
  title: string;
  text?: string;
  url: string;
  picUrl?: string; // thumbnail URL
}

/** Markdown message data */
export interface MarkdownData {
  title?: string;
  content: string; // markdown text
}

/** Rich text element for post messages */
export interface RichTextElement {
  tag: "text" | "a" | "at" | "img";
  text?: string;
  href?: string;
  userId?: string; // for @mention
  imageKey?: string;
}

/** Rich text (post) message data */
export interface RichTextData {
  title?: string;
  content: RichTextElement[][];
}

/** Action card button */
export interface ActionButton {
  title: string;
  actionUrl?: string;
  callbackId?: string; // for callback handling
}

/** Action card message data */
export interface ActionCardData {
  title: string;
  text: string; // markdown supported
  buttons?: ActionButton[];
  btnOrientation?: "0" | "1"; // 0: vertical, 1: horizontal
  singleTitle?: string; // single button title
  singleUrl?: string; // single button URL
}

/** Message options for sending */
export interface SendOptions {
  to: string;
  replyTo?: string; // message ID to reply to
  atUsers?: string[]; // user IDs to @mention
  atAll?: boolean; // @all in group
  cfg?: unknown;
}

export interface ChannelPlugin {
  name: string;
  gateway?: {
    startAccount?(ctx: unknown): Promise<void> | void;
    stopAccount?(): Promise<void> | void;
  };
  outbound?: {
    /** Send plain text message */
    sendText?(opts: SendOptions & { text: string }): Promise<void>;
    /** Send markdown message */
    sendMarkdown?(opts: SendOptions & { markdown: MarkdownData }): Promise<void>;
    /** Send image by URL */
    sendImage?(opts: SendOptions & { url: string }): Promise<void>;
    /** Send image by base64 data */
    sendImageData?(opts: SendOptions & { image: ImageData }): Promise<void>;
    /** Send file */
    sendFile?(opts: SendOptions & { file: FileData }): Promise<void>;
    /** Send audio */
    sendAudio?(opts: SendOptions & { audio: AudioData }): Promise<void>;
    /** Send video */
    sendVideo?(opts: SendOptions & { video: VideoData }): Promise<void>;
    /** Send link message */
    sendLink?(opts: SendOptions & { link: LinkData }): Promise<void>;
    /** Send rich text (post) message */
    sendRichText?(opts: SendOptions & { richText: RichTextData }): Promise<void>;
    /** Send action card with buttons */
    sendActionCard?(opts: SendOptions & { card: ActionCardData }): Promise<void>;
    /** Send text directly to a user by their channel-specific user ID (open_id, staff_id, etc.) */
    sendDirectText?(opts: { userId: string; text: string }): Promise<void>;
  };
  /** Optional streaming card support for real-time output */
  streaming?: {
    /** Create a new card and return a handle for updates */
    createCard?(opts: { to: string; title?: string }): Promise<StreamingCard>;
    /** Update the card content (incremental) */
    updateCard?(opts: { card: StreamingCard; content: string }): Promise<void>;
    /** Finalize the card (mark as complete) */
    finalizeCard?(opts: {
      card: StreamingCard;
      content: string;
      /** Tool execution details — used to build collapsible panels on supported channels */
      toolOutputs?: Array<{ name: string; command: string; output: string }>;
    }): Promise<void>;
  };
}

export interface MoltbotPluginApi {
  registerChannel(plugin: ChannelPlugin): void;
  registerTool(tool: unknown): void;
  registerHook(hook: unknown): void;
  registerHttpHandler(handler: unknown): void;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
  config: Record<string, unknown>;
  runtime: PluginRuntime;
}

export function createPluginApi(
  config: GatewayConfig,
  runtime: PluginRuntime,
): { api: MoltbotPluginApi; getChannels: () => ChannelPlugin[] } {
  const channels: ChannelPlugin[] = [];

  const api: MoltbotPluginApi = {
    registerChannel(plugin: ChannelPlugin) {
      console.log(`[plugins] Channel registered: ${plugin.name}`);
      channels.push(plugin);
    },

    registerTool(_tool: unknown) {
      console.warn("[plugins] registerTool: not implemented in siclaw gateway (no-op)");
    },

    registerHook(_hook: unknown) {
      console.warn("[plugins] registerHook: not implemented in siclaw gateway (no-op)");
    },

    registerHttpHandler(_handler: unknown) {
      console.warn("[plugins] registerHttpHandler: not implemented in siclaw gateway (no-op)");
    },

    logger: {
      info: (...args: unknown[]) => console.log("[plugin]", ...args),
      warn: (...args: unknown[]) => console.warn("[plugin]", ...args),
      error: (...args: unknown[]) => console.error("[plugin]", ...args),
      debug: (...args: unknown[]) => console.debug("[plugin]", ...args),
    },

    config: config as unknown as Record<string, unknown>,

    runtime,
  };

  return { api, getChannels: () => channels };
}
