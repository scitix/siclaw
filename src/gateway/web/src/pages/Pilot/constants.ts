/** Tool names that produce skill cards / panels in the Pilot UI. */
export const SKILL_TOOL_NAMES = new Set(['skill_preview']);

/** Check if a toolName is a skill tool. */
export function isSkillTool(toolName: string | undefined): boolean {
    return !!toolName && SKILL_TOOL_NAMES.has(toolName);
}
