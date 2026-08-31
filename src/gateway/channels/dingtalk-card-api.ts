import crypto from "node:crypto";
import type { DingTalkChannelConfig } from "./dingtalk.js";
import type { DingTalkStreamingCard } from "./dingtalk-card.js";
import { fetchWithTimeout, getAccessToken, redactSecrets } from "./dingtalk-api.js";

const CARD_CREATE_AND_DELIVER_URL = "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver";
const CARD_STREAMING_URL = "https://api.dingtalk.com/v1.0/card/streaming";
const CARD_INSTANCES_URL = "https://api.dingtalk.com/v1.0/card/instances";
const CARD_CONTENT_KEY = "content";

export interface DingTalkCardTarget {
  routeType: "user" | "group";
  conversationId: string;
  senderStaffId?: string;
}

interface CardApiResult {
  ok: boolean;
  data: Record<string, any>;
}

async function callCardApi(
  scope: string,
  url: string,
  token: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
): Promise<CardApiResult> {
  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      console.error(`[dingtalk-card] ${scope} failed: HTTP ${response.status}`);
      return { ok: false, data };
    }
    if (data.code && String(data.code) !== "0") {
      console.error(`[dingtalk-card] ${scope} rejected: code=${String(data.code)} message=${String(data.message ?? "")}`);
      return { ok: false, data };
    }
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dingtalk-card] ${scope} error: ${redactSecrets(message)}`);
    return { ok: false, data: {} };
  }
}

function extractTrackingValue(data: Record<string, any>, key: string): string | undefined {
  const candidates = [data.result?.[key], data[key]];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

/**
 * 创建并投放一张处于“输出中”状态的钉钉 AI 卡片。
 *
 * 私聊卡片必须使用发送者的 staffId 作为 IM_ROBOT openSpace 目标；如果
 * 回调没有该字段，则返回 null，让调用方回退到 sessionWebhook。
 */
export async function openTypingCard(
  config: DingTalkChannelConfig,
  target: DingTalkCardTarget,
  placeholder: string,
): Promise<DingTalkStreamingCard | null> {
  const templateId = config.card_template_id?.trim();
  if (!templateId) {
    console.warn("[dingtalk-card] AI card mode enabled without card_template_id; falling back to markdown");
    return null;
  }

  const openSpaceTarget = target.routeType === "group"
    ? target.conversationId
    : target.senderStaffId;
  if (!openSpaceTarget) {
    console.warn("[dingtalk-card] 1:1 AI card reply missing senderStaffId; falling back to markdown");
    return null;
  }

  const token = await getAccessToken(config);
  if (!token) return null;

  const outTrackId = `siclaw_${crypto.randomUUID().replaceAll("-", "")}`;
  const isGroup = target.routeType === "group";
  const body: Record<string, unknown> = {
    cardTemplateId: templateId,
    outTrackId,
    cardData: {
      cardParamMap: {
        [CARD_CONTENT_KEY]: placeholder,
        flowStatus: "2",
      },
    },
    callbackType: "STREAM",
    openSpaceId: isGroup
      ? `dtv1.card//IM_GROUP.${openSpaceTarget}`
      : `dtv1.card//IM_ROBOT.${openSpaceTarget}`,
    userIdType: 1,
    imGroupOpenSpaceModel: { supportForward: true },
    imRobotOpenSpaceModel: { supportForward: true },
    ...(isGroup
      ? { imGroupOpenDeliverModel: { robotCode: config.client_id } }
      : { imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: config.client_id } }),
  };

  const result = await callCardApi("createAndDeliver", CARD_CREATE_AND_DELIVER_URL, token, "POST", body);
  if (!result.ok) return null;

  const deliverResults = result.data.result?.deliverResults;
  if (Array.isArray(deliverResults)) {
    const failed = deliverResults.find((item: any) => item?.success === false);
    if (failed) {
      console.error(`[dingtalk-card] createAndDeliver delivery failed: ${String(failed.errorMsg ?? "unknown error")}`);
      return null;
    }
  }

  return {
    outTrackId: extractTrackingValue(result.data, "outTrackId") ?? outTrackId,
    cardInstanceId: extractTrackingValue(result.data, "cardInstanceId"),
    processQueryKey: extractTrackingValue(result.data, "processQueryKey"),
  };
}

/** 使用全量快照更新 AI 卡片正文；每次请求的 guid 用于平台侧幂等。 */
export async function streamCardContent(
  config: DingTalkChannelConfig,
  card: DingTalkStreamingCard,
  content: string,
): Promise<boolean> {
  const token = await getAccessToken(config);
  if (!token) return false;
  const result = await callCardApi("stream", CARD_STREAMING_URL, token, "PUT", {
    outTrackId: card.outTrackId,
    guid: crypto.randomUUID(),
    key: CARD_CONTENT_KEY,
    content,
    isFull: true,
    isFinalize: false,
    isError: false,
  });
  return result.ok;
}

/**
 * 关闭流式生命周期，并通过 instances API 原子写入最终正文和完成状态。
 * instances 更新成功即视为完成；流式关闭失败只记录日志，不阻止最终提交。
 */
export async function finalizeTypingCard(
  config: DingTalkChannelConfig,
  card: DingTalkStreamingCard,
  content: string,
): Promise<boolean> {
  const token = await getAccessToken(config);
  if (!token) return false;

  const streamResult = await callCardApi("stream.finalize", CARD_STREAMING_URL, token, "PUT", {
    outTrackId: card.outTrackId,
    guid: crypto.randomUUID(),
    key: CARD_CONTENT_KEY,
    content: "",
    isFull: true,
    isFinalize: true,
    isError: false,
  });
  if (!streamResult.ok) {
    console.warn(`[dingtalk-card] streaming lifecycle could not be closed for outTrackId=${card.outTrackId}; attempting final instance update`);
  }

  const finalResult = await callCardApi("instances.finalize", CARD_INSTANCES_URL, token, "PUT", {
    outTrackId: card.outTrackId,
    cardData: {
      cardParamMap: {
        [CARD_CONTENT_KEY]: content,
        flowStatus: "3",
      },
    },
    cardUpdateOptions: { updateCardDataByKey: true },
  });
  return finalResult.ok;
}
