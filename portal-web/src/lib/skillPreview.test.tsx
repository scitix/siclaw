import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { SkillCard } from "../components/chat/SkillCard"
import { SkillPanel } from "../components/chat/SkillPanel"
import type { PilotMessage } from "../components/chat/types"
import { readSkillPreview } from "./skillPreview"

const specs = "# Large skill\n" + "Read-only check.\n".repeat(800) + "END_OF_SKILL"
const skill = { name: "large-preview", description: "Preview regression", specs,
  files: [{ path: "SKILL.md", content: specs }, { path: "scripts/check.sh", content: "echo SCRIPT_END" }] }
const base: PilotMessage = { id: "m", role: "tool", toolName: "skill_preview", timestamp: "",
  content: "[Full tool output stored as a recoverable artifact]\nartifact_id: tra_example\nPreview: {\"skill\":" }

describe("skill previews", () => {
  it.each(["toolDetails", "metadata"] as const)("renders full card and files from %s despite truncated text", source => {
    const message = { ...base, [source]: { skillPreview: { skill } } }
    expect(readSkillPreview(message)).toEqual(skill)
    const card = renderToStaticMarkup(<SkillCard message={message} />)
    const panel = renderToStaticMarkup(<SkillPanel message={message} onClose={() => {}} />)
    expect(card).toContain("large-preview")
    expect(panel).toContain("END_OF_SKILL")
    expect(panel).toContain("scripts/check.sh")
    expect(panel).not.toContain("artifact_id")
  })

  it("keeps legacy JSON previews readable", () => {
    const message = { ...base, content: JSON.stringify({ skill }) }
    expect(readSkillPreview(message)).toEqual(skill)
    expect(renderToStaticMarkup(<SkillPanel message={message} onClose={() => {}} />)).toContain("END_OF_SKILL")
  })

  it("offers copy only for real text content, including empty legacy files", () => {
    const message = { ...base, toolDetails: { skillPreview: { skill: { name: "files", files: [
      { path: "SKILL.md", content: specs },
      { path: "assets/icon.png", content: "AA==", encoding: "base64", size: 1 },
      { path: "empty.txt", content: "" },
    ] } } } }
    const panel = renderToStaticMarkup(<SkillPanel message={message} onClose={() => {}} />)
    expect(panel).toContain('aria-label="Copy SKILL.md"')
    expect(panel).toContain('aria-label="Copy empty.txt"')
    expect(panel).not.toContain('aria-label="Copy assets/icon.png"')
    expect(panel).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/)

    const legacy = { ...base, content: JSON.stringify({ skill: { name: "legacy", scripts: [{ name: "empty.sh", content: "" }] } }) }
    expect(renderToStaticMarkup(<SkillPanel message={legacy} onClose={() => {}} />))
      .toContain('aria-label="Copy scripts/empty.sh"')
  })

  it("prefers structured details over model text", () => {
    expect(readSkillPreview({ ...base, content: JSON.stringify({ skill: { name: "stale" } }),
      toolDetails: { skillPreview: { skill } } })).toEqual(skill)
  })

  it.each([
    undefined, { skill: null }, { skill: { name: "" } },
    { skill: { name: "bad", specs: {} } }, { skill: { name: "bad", scripts: [null] } },
    { skill: { name: "bad", files: [{ path: "SKILL.md", content: {} }] } },
  ])("shows an unavailable preview instead of hiding or crashing on invalid data: %j", value => {
    const message = { ...base, toolDetails: { skillPreview: value } }
    expect(readSkillPreview(message)).toBeUndefined()
    expect(renderToStaticMarkup(<SkillCard message={message} />)).toContain("Skill preview unavailable")
    expect(renderToStaticMarkup(<SkillPanel message={message} onClose={() => {}} />)).toContain("generate the preview again")
  })

  it("falls back to a valid old payload if structured metadata is malformed", () => {
    expect(readSkillPreview({ ...base, content: JSON.stringify({ skill }),
      toolDetails: { skillPreview: { skill: { name: "bad", files: "invalid" } } } })).toEqual(skill)
  })
})
