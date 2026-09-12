// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import * as client from "../api";
import { SkillCard } from "../components/chat/SkillCard";
import { SkillPanel } from "../components/chat/SkillPanel";
import type { PilotMessage } from "../components/chat/types";

it("fetches only an opened preview, copies complete files, and shows omission without fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const metadata = { skillPreview: { skill: { name: "preview", specs: "界".repeat(50000) + "END_OF_SKILL" } } };
  const load = vi.spyOn(client, "api").mockResolvedValue({ data: [{ id: "m", metadata }] });
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const message: PilotMessage = { id: "m", role: "tool", content: JSON.stringify(metadata.skillPreview), timestamp: "", metadata: { skillPreview: { name: "preview", status: "deferred" } } };
  try {
    act(() => root.render(<SkillCard message={message} />));
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.render(<SkillPanel message={message} detailUrl="/preview?message_id=m" onClose={() => {}} />));
    expect(load).toHaveBeenCalledOnce();
    expect(element.querySelector("pre")?.textContent).toBe(metadata.skillPreview.skill.specs);
    await act(async () => (element.querySelector('[aria-label="Copy SKILL.md"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith(metadata.skillPreview.skill.specs);
    await act(async () => root.render(<SkillPanel message={{ ...message, id: "omitted", metadata: { skillPreview: { status: "omitted", name: "preview" } } }} detailUrl="/unused" onClose={() => {}} />));
    expect(load).toHaveBeenCalledOnce();
    expect(element.textContent).toContain("could not be saved");
    expect(element.querySelector("pre")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
