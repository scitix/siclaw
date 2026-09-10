import { useSyncExternalStore } from "react"

export interface TraceLabels {
  language: string
  followPlatform: string
  close: string
  exportFailed: string
  details: string
  selected: string
  timing: string
  coverage: string
  help: string
  legendHttp: string
  legendOther: string
  legendUnknown: string
  statusOk: string
  statusError: string
  statusCancelled: string
  statusUnset: string
  attempt: string
  request: string
  trace: string
  unknownHint: string
  selectHint: string
  title: string
  attempts: string
  hierarchy: string
  stages: string
  range: string
  zoom: string
  fit: string
  reset: string
  duration: string
  start: string
  end: string
  status: string
  span: string
  parent: string
  evidence: string
  missing: string
  observed: string
  unknown: string
  partial: string
  root: string
  investigate: string
  pending: string
  failed: string
  grouping: string
  outside: string
  emptyRange: string
  brushHint: string
  seconds: string
  spans: string
  httpCalls: string
  open: string
  internal: string
  raw: string
  export: string
  preview: string
  expand: string
  collapse: string
  gap: string
  gaps: string
}
export const TRACE_EN: TraceLabels = {
  language: "Chart language",
  followPlatform: "Auto",
  close: "Close",
  exportFailed: "PNG export failed. The chart and data remain available.",
  details: "Call details",
  selected: "Selected call",
  timing: "Timing",
  coverage: "Observation coverage",
  help: "Interaction help",
  legendHttp: "HTTP call",
  legendOther: "Other stage",
  legendUnknown: "Unknown end",
  statusOk: "OK",
  statusError: "Error",
  statusCancelled: "Cancelled",
  statusUnset: "Not set",
  attempt: "Attempt",
  request: "Request",
  trace: "Trace",
  unknownHint: "Dashed intervals have no observed end.",
  selectHint: "Select a call to inspect its evidence.",
  title: "Request timeline",
  attempts: "By attempt",
  hierarchy: "Span hierarchy",
  stages: "Stage / call",
  range: "Time window",
  zoom: "Zoom",
  fit: "Focus selected",
  reset: "Full trace",
  duration: "Duration",
  start: "Start",
  end: "End",
  status: "Status",
  span: "Span",
  parent: "Actual parent",
  evidence: "Evidence",
  missing: "Missing observations",
  observed: "Observed",
  unknown: "Unknown",
  partial: "Partial trace",
  root: "Root span",
  investigate: "Investigate this interval",
  pending: "Sending…",
  failed: "Could not send. Try again.",
  grouping:
    "Attempt groups do not change actual parent spans. Route and HTTP durations overlap; do not add them.",
  outside:
    "Some spans extend beyond the root interval. Check clock alignment and trace completeness.",
  emptyRange: "Outside the selected window",
  brushHint: "Drag to zoom; move selection to pan. Arrow keys pan, +/− zoom.",
  seconds: "Seconds from request origin",
  spans: "spans",
  httpCalls: "HTTP calls",
  open: "End not observed",
  internal: "Other observed stages",
  raw: "View",
  export: "Download PNG",
  preview: "Larger view",
  expand: "View timeline",
  collapse: "Collapse timeline",
  gap: "observation gap",
  gaps: "observation gaps",
}

export const TRACE_ZH: TraceLabels = {
  language: "图表语言",
  followPlatform: "跟随平台",
  close: "关闭",
  exportFailed: "PNG 导出失败，图表和数据仍可查看。",
  details: "调用详情",
  selected: "已选调用",
  timing: "时间区间",
  coverage: "观测范围",
  help: "交互帮助",
  legendHttp: "HTTP 调用",
  legendOther: "其他阶段",
  legendUnknown: "未知终点",
  statusOk: "正常",
  statusError: "错误",
  statusCancelled: "已取消",
  statusUnset: "未标记",
  attempt: "尝试",
  request: "请求",
  trace: "链路",
  unknownHint: "虚线表示未观测到终点，不能视为零耗时。",
  selectHint: "选择调用以查看对应证据。",
  title: "请求时间线",
  attempts: "按尝试分组",
  hierarchy: "原始 Span 层级",
  stages: "阶段 / 调用",
  range: "时间窗",
  zoom: "缩放",
  fit: "放大选中",
  reset: "全程",
  duration: "耗时",
  start: "起点",
  end: "终点",
  status: "状态",
  span: "Span",
  parent: "真实父 Span",
  evidence: "证据",
  missing: "缺失观测",
  observed: "已观测",
  unknown: "未知",
  partial: "部分链路",
  root: "根 Span",
  investigate: "分析这段耗时",
  pending: "发送中…",
  failed: "发送失败，请重试。",
  grouping:
    "路由与 HTTP 区间存在重叠，耗时不能相加；按尝试分组不改变真实父子关系。",
  outside: "部分 Span 超出了根请求区间，需要核对时钟和链路完整性。",
  emptyRange: "当前时间窗之外",
  brushHint: "拖选缩放，拖动选区平移；方向键平移，加减键缩放。",
  seconds: "相对请求起点（秒）",
  spans: "个 Span",
  httpCalls: "次 HTTP 调用",
  open: "未观测到终点",
  internal: "其他观测阶段",
  raw: "查看方式",
  export: "下载 PNG",
  preview: "放大查看",
  expand: "展开时间线",
  collapse: "收起时间线",
  gap: "项观测缺口",
  gaps: "项观测缺口",
}

export type TraceLocale = "en" | "zh"
export type TraceLanguagePreference = "auto" | TraceLocale
const STORAGE_KEY = "siclaw.traceLanguage.v1"
const CHANGE_EVENT = "siclaw:trace-language-change"
let memoryPreference: TraceLanguagePreference | undefined

export function normalizeTraceLocale(locale?: string): TraceLocale {
  return locale?.toLowerCase().split(/[-_]/)[0] === "zh" ? "zh" : "en"
}
export function resolveTraceLocale(
  preference: TraceLanguagePreference,
  platformLocale?: string,
): TraceLocale {
  return preference === "auto"
    ? normalizeTraceLocale(platformLocale)
    : preference
}
function readPreference(): TraceLanguagePreference {
  if (memoryPreference) return memoryPreference
  if (typeof window === "undefined") return "auto"
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return saved === "en" || saved === "zh" ? saved : "auto"
  } catch {
    return "auto"
  }
}
function subscribe(listener: () => void) {
  const storage = () => {
    memoryPreference = undefined
    listener()
  }
  window.addEventListener(CHANGE_EVENT, listener)
  window.addEventListener("storage", storage)
  window.addEventListener("languagechange", listener)
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener)
    window.removeEventListener("storage", storage)
    window.removeEventListener("languagechange", listener)
  }
}
export function setTraceLanguage(preference: TraceLanguagePreference) {
  memoryPreference = preference
  try {
    window.localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // A blocked preference store must not prevent switching during this visit.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}
export function useTraceLocale(platformLocale?: string) {
  // Include browser language in the snapshot so a languagechange triggers rendering.
  const snapshot = useSyncExternalStore(
    subscribe,
    () =>
      `${readPreference()}:${typeof navigator === "undefined" ? "en" : navigator.language}`,
    () => "auto:en",
  )
  const [saved, browserLanguage] = snapshot.split(":")
  const preference = saved as TraceLanguagePreference
  const locale = resolveTraceLocale(
    preference,
    platformLocale ?? browserLanguage,
  )
  return {
    locale,
    preference,
    labels: locale === "zh" ? TRACE_ZH : TRACE_EN,
    setPreference: setTraceLanguage,
  }
}
