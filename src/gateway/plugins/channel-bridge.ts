import type { AgentBoxManager } from "../agentbox/manager.js";
import { AgentBoxClient, type AgentBoxTlsOptions } from "../agentbox/client.js";
import type { BroadcastFn } from "../ws-protocol.js";
import type { ChannelPlugin, StreamingCard } from "./api.js";
import type { UserStore } from "../auth/user-store.js";
import type { ConfigRepository } from "../db/repositories/config-repo.js";
import type { WorkspaceRepository } from "../db/repositories/workspace-repo.js";
import { notifyCronService } from "../cron/notify.js";
import { buildRedactionConfig, redactText, type RedactionConfig } from "../output-redactor.js";

export type OutboundSender = (sessionKey: string, text: string) => Promise<void>;

/** Image content for multimodal input */
export interface ImageInput {
  data: string; // base64 encoded
  mimeType: string; // e.g., "image/png", "image/jpeg"
}

/** File content for document input */
export interface FileInput {
  data: string; // base64 encoded
  mimeType: string;
  filename: string;
}

/** Audio content */
export interface AudioInput {
  data: string; // base64 encoded
  mimeType: string;
  duration?: number; // seconds
}

/** Video content */
export interface VideoInput {
  data: string; // base64 encoded
  mimeType: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** Location content */
export interface LocationInput {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/** Sticker/emoji content */
export interface StickerInput {
  stickerId: string;
  emoji?: string;
}

/** Combined media inputs */
export interface MediaInputs {
  images?: ImageInput[];
  files?: FileInput[];
  audios?: AudioInput[];
  videos?: VideoInput[];
  location?: LocationInput;
  sticker?: StickerInput;
}

export interface ChannelBridge {
  handleInbound(
    channelId: string,
    chatId: string,
    senderId: string,
    text: string,
    media?: MediaInputs,
  ): Promise<void>;

  registerOutbound(channelId: string, plugin: ChannelPlugin): void;

  /** Optional hook called on every inbound message (used to remember chatId) */
  onInbound?: (channelId: string, chatId: string) => void;
}

export function createChannelBridge(
  agentBoxManager: AgentBoxManager,
  broadcast: BroadcastFn,
  userStore?: UserStore,
  configRepo?: ConfigRepository,
  buildCredentialPayload?: (userId: string, workspaceId: string, isDefault: boolean) => Promise<{ manifest: Array<{ name: string; type: string; description?: string | null; files: string[]; metadata?: Record<string, unknown> }>; files: Array<{ name: string; content: string; mode?: number }> }>,
  workspaceRepo?: WorkspaceRepository,
  agentBoxTlsOptions?: AgentBoxTlsOptions,
): ChannelBridge {
  // channelId → outbound sender
  const outbounds = new Map<string, ChannelPlugin>();

  const bridge: ChannelBridge = {
    async handleInbound(
      channelId: string,
      chatId: string,
      senderId: string,
      text: string,
      media?: MediaInputs,
    ) {
      const sessionKey = `${channelId}/${chatId}`;
      console.log(
        `[channel-bridge] Inbound from ${channelId}/${senderId}: ${text.slice(0, 80)}`,
      );

      // Notify hook (e.g. remember chatId for notifications)
      bridge.onInbound?.(channelId, chatId);

      // Check if sender is bound to a platform user
      const boundUser = userStore?.getByBinding(
        channelId,
        senderId,
      );

      // Unbound users cannot use the bot — guide them to bind first
      if (!boundUser) {
        const plugin = outbounds.get(channelId);
        const guide = [
          "Your account is not linked to Siclaw yet. Please complete the binding first:",
          "",
          `1. Open the Siclaw platform: ${process.env.SICLAW_PLATFORM_URL || "https://your-platform-url"}`,
          "2. Log in and go to the Settings page",
          "3. Click \"Generate Bind Code\" to get a 6-digit code",
          "4. Come back here and send: /bind <6-digit code>",
          "",
          "Once bound, you can start using Siclaw.",
        ].join("\n");
        if (plugin?.outbound?.sendText) {
          await plugin.outbound.sendText({ to: chatId, text: guide });
        }
        console.log(`[channel-bridge] Unbound sender ${channelId}/${senderId}, sent bind guide`);
        return;
      }

      // Resolve user's default workspace
      if (!workspaceRepo) throw new Error("Database not available");
      const defaultWs = await workspaceRepo.getOrCreateDefault(boundUser.id);

      // Build credential payload to send in prompt body
      const credentials = buildCredentialPayload
        ? await buildCredentialPayload(boundUser.id, defaultWs.id, defaultWs.isDefault).catch((err) => {
            console.warn("[channel-bridge] credential payload build failed:", err instanceof Error ? err.message : err);
            return undefined;
          })
        : undefined;

      // Build redaction config for outbound channel messages
      const redactionConfig: RedactionConfig = buildRedactionConfig(
        credentials?.manifest,
        credentials?.manifest?.length ? ".siclaw/credentials" : undefined,
      );

      // Channel and web share the same AgentBox — mode-driven skill loading
      // handles tool/skill differences per session.
      const handle = await agentBoxManager.getOrCreate(boundUser.id, defaultWs.id);
      const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

      const plugin = outbounds.get(channelId);

      // Build prompt text (append file info since AgentBox HTTP API is text-only)
      let promptText = text;
      if (media?.files?.length) {
        const fileInfo = media.files
          .map((f) => `[Attachment: ${f.filename} (${f.mimeType})]`)
          .join("\n");
        promptText = `${text}\n\n${fileInfo}`;
      }

      // Send prompt — channel mode loads manage-skill SKILL.md instead of create/update tools
      // Use chatId as sessionId so different chats (groups, DMs, devices) are isolated
      const result = await client.prompt({
        sessionId: chatId,
        text: promptText,
        mode: "channel",
        credentials,
      });
      console.log(
        `[channel-bridge] Prompt sent to AgentBox ${handle.boxId} session=${result.sessionId}`,
      );

      // Check if channel supports streaming cards
      const supportsStreaming = !!(
        plugin?.streaming?.createCard &&
        plugin?.streaming?.updateCard &&
        plugin?.streaming?.finalizeCard
      );

      // Consume SSE events from AgentBox in the background
      (async () => {
        let card: StreamingCard | null = null;
        let cardPromise: Promise<StreamingCard> | null = null;
        let finalized = false;
        let eventCount = 0;

        // Process display: tool execution log + final text response.
        // Feishu CardKit streaming markdown element has ~4KB content limit.
        // When content exceeds the threshold we finalize the current card
        // and create a new continuation card, preserving all steps visibly.
        const MAX_CARD_CONTENT = 3500;
        let cardIndex = 0;                 // how many cards have been finalized
        const toolEntries: string[] = [];  // per-tool-call display blocks
        let currentToolEntry = "";         // entry being built (start → end)
        let assistantText = "";            // streamed text_delta content

        // Full tool outputs for collapsible panels on finalization
        interface ToolOutput { name: string; command: string; output: string }
        const fullToolOutputs: ToolOutput[] = [];
        let currentToolMeta: { name: string; command: string } | null = null;

        /** Build the full card content from current entries */
        function getDisplayContent(): string {
          // Separate tool entries with thin dividers for visual clarity
          let log = toolEntries.join("\n---\n");
          if (currentToolEntry) {
            log += (log ? "\n---\n" : "") + currentToolEntry;
          }
          if (assistantText && log) {
            return log + "\n\n---\n\n" + assistantText;
          }
          return assistantText || log || "⏳ Thinking...";
        }

        /** Finalize the current card and open a new one (card rollover) */
        async function rolloverCard(): Promise<void> {
          if (!card || !supportsStreaming) return;
          if (updateInFlight) await updateInFlight;
          const content = getDisplayContent();
          try {
            await plugin!.streaming!.finalizeCard!({ card: card!, content });
          } catch (err) {
            console.error(`[channel-bridge] Rollover finalize failed:`, err);
          }
          cardIndex++;
          // Reset display state for the new card
          toolEntries.length = 0;
          currentToolEntry = "";
          assistantText = "";
          // Create a new continuation card
          try {
            card = await plugin!.streaming!.createCard!({ to: chatId });
            console.log(`[channel-bridge] Rollover card #${cardIndex + 1} for ${sessionKey}`);
          } catch (err) {
            console.error(`[channel-bridge] Rollover card create failed:`, err);
            card = null;
          }
        }

        // "Latest value" update pattern: at most one HTTP request in-flight,
        // new content replaces pending instead of queuing unboundedly.
        let updateInFlight: Promise<void> | null = null;
        let pendingContent: string | null = null;

        function scheduleUpdate(content: string) {
          pendingContent = content;
          if (updateInFlight) return; // in-flight request will pick up latest when done

          const run = async () => {
            while (pendingContent !== null && card && !finalized) {
              const c = pendingContent;
              pendingContent = null;
              try {
                await plugin!.streaming!.updateCard!({ card: card!, content: c });
              } catch (err) {
                console.error(`[channel-bridge] Failed to update card:`, err);
              }
            }
            updateInFlight = null;
          };

          updateInFlight = run();
        }

        // Create streaming card immediately after prompt (don't wait for message_start)
        if (supportsStreaming) {
          cardPromise = plugin.streaming!.createCard!({ to: chatId });
          cardPromise
            .then((c) => {
              card = c;
              console.log(`[channel-bridge] Created streaming card for ${sessionKey}`);
              // Flush any content accumulated while card was being created
              const display = getDisplayContent();
              if (display !== "⏳ Thinking...") {
                scheduleUpdate(display);
              }
            })
            .catch((err) => {
              cardPromise = null;
              console.error(`[channel-bridge] Failed to create card:`, err);
            });
        }

        /** Truncate long tool output for display — keep it compact */
        function truncateOutput(text: string, maxLines = 6, maxChars = 300): string {
          const lines = text.split("\n");
          let result: string;
          let truncated = false;
          if (lines.length > maxLines) {
            result = lines.slice(0, maxLines).join("\n");
            truncated = true;
          } else {
            result = text;
          }
          if (result.length > maxChars) {
            // Cut at last newline before maxChars to avoid mid-line breaks
            const cut = result.lastIndexOf("\n", maxChars);
            result = cut > 0 ? result.slice(0, cut) : result.slice(0, maxChars);
            truncated = true;
          }
          return truncated ? result + "\n..." : result;
        }

        /** Extract a short command summary from tool args */
        function toolArgsSummary(
          toolName: string,
          args: Record<string, unknown> | undefined,
        ): string {
          if (!args) return "";
          // node_exec: show "node $ command"
          if (toolName === "node_exec" && args.node && args.command) {
            return `${args.node} $ ${String(args.command).slice(0, 200)}`;
          }
          // bash: show the command
          if (args.command) return String(args.command).split("\n")[0].slice(0, 200);
          // run_skill: show "skill/script args"
          if (args.skill && args.script) {
            const s = `${args.skill}/${args.script}`;
            return args.args ? `${s} ${String(args.args).slice(0, 100)}` : s;
          }
          // file read/write
          if (args.file_path) return String(args.file_path);
          // grep/glob
          if (args.pattern) return `pattern: ${String(args.pattern).slice(0, 100)}`;
          // generic: show first string value
          for (const v of Object.values(args)) {
            if (typeof v === "string" && v.length > 0) return v.slice(0, 100);
          }
          return "";
        }

        try {
          for await (const event of client.streamEvents(result.sessionId)) {
            const evt = event as Record<string, unknown>;
            const eventType = evt.type as string;
            eventCount++;

            // --- tool_execution_start: show tool name + command ---
            if (eventType === "tool_execution_start") {
              // Commit previous entry if any
              if (currentToolEntry) {
                toolEntries.push(currentToolEntry);
                currentToolEntry = "";
              }
              // When a new tool call starts after assistant text was streamed,
              // fold the intermediate text into toolEntries so it's visible
              // but can be trimmed like other entries.
              if (assistantText) {
                toolEntries.push(assistantText);
                assistantText = "";
              }
              const toolName = (evt.toolName as string) || "tool";
              const args = evt.args as Record<string, unknown> | undefined;
              const summary = toolArgsSummary(toolName, args);
              currentToolMeta = { name: toolName, command: summary };
              currentToolEntry = summary
                ? `**🔧 ${toolName}** \`${summary}\``
                : `**🔧 ${toolName}**`;
              if (supportsStreaming && card) {
                scheduleUpdate(getDisplayContent() + "\n⏳ Running...");
              }
            }

            // --- tool_execution_end: show result ---
            if (eventType === "tool_execution_end") {
              const toolName = (evt.toolName as string) || "";
              const toolResult = evt.result as
                | { content?: Array<{ type: string; text?: string }> }
                | undefined;
              let output = redactText(
                toolResult?.content
                  ?.filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("") ?? "",
                redactionConfig,
              );

              // Auto-execute manage_schedule results (except list)
              // Only attempt parse when output looks like JSON (starts with '{')
              if (toolName === "manage_schedule" && output && configRepo && boundUser && output.trimStart().startsWith("{")) {
                try {
                  const parsed = JSON.parse(output) as {
                    action?: string;
                    id?: string;
                    name?: string;
                    newName?: string;
                    schedule?: { name: string; description?: string; schedule: string; status?: string };
                    summary?: string;
                  };
                  const action = parsed.action;
                  if (action && action !== "list") {
                    await executeScheduleAction(parsed, boundUser.id, configRepo, undefined, defaultWs.id);
                    // Replace raw JSON with human-readable summary
                    if (parsed.summary) {
                      output = parsed.summary;
                    }
                  }
                } catch (err) {
                  console.error(`[channel-bridge] Failed to auto-execute schedule:`, err);
                }
              }

              // Store full output for collapsible panels
              if (currentToolMeta) {
                fullToolOutputs.push({ ...currentToolMeta, output });
                currentToolMeta = null;
              }

              if (output) {
                // Use blockquote for tool output — visually indented under tool name
                const truncated = truncateOutput(output);
                const quoted = truncated.split("\n").map(l => `> ${l}`).join("\n");
                currentToolEntry += `\n${quoted}`;
              }
              // Commit this tool entry now that it's complete
              toolEntries.push(currentToolEntry);
              currentToolEntry = "";

              // Roll over to a new card if content is approaching the limit
              if (supportsStreaming && card && getDisplayContent().length > MAX_CARD_CONTENT) {
                await rolloverCard();
              } else if (supportsStreaming && card) {
                scheduleUpdate(getDisplayContent());
              }
            }

            // --- message_update: accumulate text_delta ---
            if (eventType === "message_update") {
              const ame = evt.assistantMessageEvent as
                | { type: string; delta?: string }
                | undefined;
              if (ame?.type === "text_delta" && ame.delta) {
                assistantText += redactText(ame.delta, redactionConfig);
                if (supportsStreaming && card) {
                  scheduleUpdate(getDisplayContent());
                }
              }
            }

            // --- agent_end: wait for in-flight update, then finalize ---
            if (eventType === "agent_end") {
              finalized = true;
              if (updateInFlight) await updateInFlight;

              // Fallback: if no text_delta was streamed, extract the last
              // assistant text from agent_end.messages (works for models
              // that use extended thinking where text isn't streamed).
              if (!assistantText) {
                const messages = evt.messages as
                  | Array<{ role: string; content: Array<{ type: string; text?: string }> }>
                  | undefined;
                if (messages) {
                  for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].role === "assistant") {
                      const textBlocks = messages[i].content
                        ?.filter((b) => b.type === "text" && b.text)
                        .map((b) => b.text!)
                        .join("\n");
                      if (textBlocks) {
                        assistantText = textBlocks;
                        break;
                      }
                    }
                  }
                }
              }

              const finalContent = getDisplayContent();
              console.log(
                `[channel-bridge] agent_end for ${sessionKey}: ${eventCount} events, text=${assistantText.length} chars, toolEntries=${toolEntries.length}`,
              );

              const finalize = (resolvedCard: StreamingCard | null) => {
                if (resolvedCard) {
                  plugin!.streaming!
                    .finalizeCard!({
                      card: resolvedCard,
                      content: finalContent,
                      toolOutputs: fullToolOutputs.length > 0 ? fullToolOutputs : undefined,
                    })
                    .catch((err) => {
                      console.error(`[channel-bridge] Failed to finalize card:`, err);
                    });
                } else if (finalContent && plugin?.outbound?.sendText) {
                  plugin.outbound
                    .sendText({ to: chatId, text: finalContent })
                    .catch((err) => {
                      console.error(`[channel-bridge] Fallback sendText error:`, err);
                    });
                }
              };

              if (card) {
                finalize(card);
              } else if (cardPromise) {
                cardPromise.then((c) => finalize(c)).catch(() => finalize(null));
              } else {
                finalize(null);
              }
              break;
            }
          }

          // Safety net: SSE stream ended without agent_end
          if (!finalized) {
            if (updateInFlight) await updateInFlight;
            const content = getDisplayContent() || "(No response received)";
            const finalizeOrSend = (resolvedCard: StreamingCard | null) => {
              if (resolvedCard && supportsStreaming) {
                plugin!.streaming!.finalizeCard!({ card: resolvedCard, content }).catch(() => {});
              } else if (plugin?.outbound?.sendText) {
                plugin.outbound.sendText({ to: chatId, text: content }).catch(() => {});
              }
            };
            if (card) {
              finalizeOrSend(card);
            } else if (cardPromise) {
              cardPromise.then((c) => finalizeOrSend(c)).catch(() => finalizeOrSend(null));
            } else {
              finalizeOrSend(null);
            }
            console.warn(
              `[channel-bridge] SSE ended without agent_end for ${sessionKey}: ${eventCount} events`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[channel-bridge] SSE error for ${sessionKey}: ${msg} (after ${eventCount} events)`,
          );
          broadcast("error", { sessionKey, message: msg });

          if (updateInFlight) await updateInFlight;
          const content = getDisplayContent() || `⚠️ Error: ${msg}`;
          const finalizeOrSend = (resolvedCard: StreamingCard | null) => {
            if (resolvedCard && supportsStreaming) {
              plugin!.streaming!.finalizeCard!({ card: resolvedCard, content }).catch(() => {});
            } else if (plugin?.outbound?.sendText) {
              plugin.outbound.sendText({ to: chatId, text: content }).catch(() => {});
            }
          };
          if (card) {
            finalizeOrSend(card);
          } else if (cardPromise) {
            cardPromise.then((c) => finalizeOrSend(c)).catch(() => finalizeOrSend(null));
          } else {
            finalizeOrSend(null);
          }
        }
      })();
    },

    registerOutbound(channelId: string, plugin: ChannelPlugin) {
      outbounds.set(channelId, plugin);
      console.log(`[channel-bridge] Registered outbound for channel: ${channelId}`);
    },
  };

  return bridge;
}

/**
 * Auto-execute a manage_schedule tool result (Feishu equivalent of ScheduleCard RPC calls).
 */
async function executeScheduleAction(
  parsed: {
    action?: string;
    id?: string;
    name?: string;
    newName?: string;
    schedule?: { name: string; description?: string; schedule: string; status?: string };
    summary?: string;
  },
  userId: string,
  configRepo: ConfigRepository,
  envId?: string,
  workspaceId?: string,
): Promise<void> {
  const action = parsed.action;

  if (action === "create" && parsed.schedule) {
    const id = await configRepo.saveCronJob(userId, {
      name: parsed.schedule.name,
      description: parsed.schedule.description,
      schedule: parsed.schedule.schedule,
      status: (parsed.schedule.status as "active" | "paused") || "active",
      envId: envId ?? null,
      workspaceId: workspaceId ?? null,
    });

    let assignedTo: string | null = null;
    try {
      const leastLoaded = await configRepo.getLeastLoadedInstance();
      if (leastLoaded) {
        assignedTo = leastLoaded.instanceId;
        await configRepo.assignCronJob(id, assignedTo);
      }
    } catch { /* coordinator will pick up */ }

    notifyCronService({
      action: "upsert",
      job: {
        id, userId, name: parsed.schedule.name,
        description: parsed.schedule.description ?? null,
        schedule: parsed.schedule.schedule,
        status: parsed.schedule.status || "active",
        skillId: null, assignedTo,
        lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
        envId: envId ?? null,
        workspaceId: workspaceId ?? null,
      },
    }, configRepo);
    console.log(`[channel-bridge] Auto-created cron job: ${id}`);
  }

  if (action === "update" && parsed.schedule) {
    const job = parsed.id
      ? await configRepo.getCronJobById(parsed.id)
      : await findJobByName(configRepo, userId, parsed.name, envId, workspaceId);
    if (!job) {
      console.warn(`[channel-bridge] Schedule not found for update: id=${parsed.id} name=${parsed.name}`);
      return;
    }
    await configRepo.saveCronJob(userId, {
      id: job.id,
      name: parsed.schedule.name || job.name,
      description: parsed.schedule.description ?? job.description ?? undefined,
      schedule: parsed.schedule.schedule || job.schedule,
      status: (parsed.schedule.status as "active" | "paused") || (job.status as "active" | "paused"),
      envId: envId ?? job.envId ?? null,
      workspaceId: job.workspaceId ?? null,
    });

    notifyCronService({
      action: "upsert",
      job: {
        id: job.id, userId, name: parsed.schedule.name || job.name,
        description: parsed.schedule.description ?? job.description ?? null,
        schedule: parsed.schedule.schedule || job.schedule,
        status: parsed.schedule.status || job.status,
        skillId: job.skillId ?? null, assignedTo: job.assignedTo ?? null,
        lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
        envId: envId ?? job.envId ?? null,
        workspaceId: job.workspaceId ?? null,
      },
    }, configRepo);
    console.log(`[channel-bridge] Auto-updated cron job: ${job.id}`);
  }

  if (action === "delete") {
    const job = parsed.id
      ? await configRepo.getCronJobById(parsed.id)
      : await findJobByName(configRepo, userId, parsed.name, envId, workspaceId);
    if (!job) {
      console.warn(`[channel-bridge] Schedule not found for delete: id=${parsed.id} name=${parsed.name}`);
      return;
    }
    await configRepo.deleteCronJob(job.id);
    notifyCronService({ action: "delete", jobId: job.id }, configRepo);
    console.log(`[channel-bridge] Auto-deleted cron job: ${job.id}`);
  }

  if (action === "pause") {
    const job = parsed.id
      ? await configRepo.getCronJobById(parsed.id)
      : await findJobByName(configRepo, userId, parsed.name, envId, workspaceId);
    if (!job) {
      console.warn(`[channel-bridge] Schedule not found for pause: id=${parsed.id} name=${parsed.name}`);
      return;
    }
    await configRepo.saveCronJob(userId, {
      id: job.id,
      name: job.name,
      description: job.description ?? undefined,
      schedule: job.schedule,
      status: "paused",
      envId: job.envId ?? null,
      workspaceId: job.workspaceId ?? null,
    });
    notifyCronService({ action: "pause", jobId: job.id }, configRepo);
    console.log(`[channel-bridge] Auto-paused cron job: ${job.id}`);
  }

  if (action === "resume") {
    const job = parsed.id
      ? await configRepo.getCronJobById(parsed.id)
      : await findJobByName(configRepo, userId, parsed.name, envId, workspaceId);
    if (!job) {
      console.warn(`[channel-bridge] Schedule not found for resume: id=${parsed.id} name=${parsed.name}`);
      return;
    }
    await configRepo.saveCronJob(userId, {
      id: job.id,
      name: job.name,
      description: job.description ?? undefined,
      schedule: job.schedule,
      status: "active",
      envId: job.envId ?? null,
      workspaceId: job.workspaceId ?? null,
    });
    notifyCronService({
      action: "upsert",
      job: {
        id: job.id, userId, name: job.name,
        description: job.description ?? null,
        schedule: job.schedule, status: "active",
        skillId: job.skillId ?? null, assignedTo: job.assignedTo ?? null,
        lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
        envId: job.envId ?? null,
        workspaceId: job.workspaceId ?? null,
      },
    }, configRepo);
    console.log(`[channel-bridge] Auto-resumed cron job: ${job.id}`);
  }

  if (action === "rename") {
    const job = parsed.id
      ? await configRepo.getCronJobById(parsed.id)
      : await findJobByName(configRepo, userId, parsed.name, envId, workspaceId);
    if (!job) {
      console.warn(`[channel-bridge] Schedule not found for rename: id=${parsed.id} name=${parsed.name}`);
      return;
    }
    const newName = parsed.newName?.trim() || job.name;
    await configRepo.saveCronJob(userId, {
      id: job.id,
      name: newName,
      description: job.description ?? undefined,
      schedule: job.schedule,
      status: job.status as "active" | "paused",
      envId: job.envId ?? null,
      workspaceId: job.workspaceId ?? null,
    });
    notifyCronService({
      action: "upsert",
      job: {
        id: job.id, userId, name: newName,
        description: job.description ?? null,
        schedule: job.schedule, status: job.status,
        skillId: job.skillId ?? null, assignedTo: job.assignedTo ?? null,
        lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
        envId: job.envId ?? null,
        workspaceId: job.workspaceId ?? null,
      },
    }, configRepo);
    console.log(`[channel-bridge] Auto-renamed cron job: ${job.id} → ${newName}`);
  }
}

/** Find a cron job by name for a user, optionally scoped to environment and workspace */
async function findJobByName(
  configRepo: ConfigRepository,
  userId: string,
  name?: string,
  envId?: string,
  workspaceId?: string,
): Promise<{ id: string; name: string; description?: string | null; schedule: string; status: string; skillId?: string | null; assignedTo?: string | null; envId?: string | null; workspaceId?: string | null } | null> {
  if (!name) return null;
  const opts: { envId?: string; workspaceId?: string } = {};
  if (envId) opts.envId = envId;
  if (workspaceId) opts.workspaceId = workspaceId;
  const jobs = await configRepo.listCronJobs(userId, Object.keys(opts).length > 0 ? opts : undefined);
  return jobs.find(j => j.name === name) as any ?? null;
}
