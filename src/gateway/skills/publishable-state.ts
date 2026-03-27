export interface PublishableSkillMetadata {
  name?: string | null;
  description?: string | null;
  type?: string | null;
  labels?: string[] | null;
}

export interface PublishableSkillFiles {
  specs?: string | null;
  scripts?: Array<{ name: string; content: string }> | null;
}

export interface PublishableSkillState {
  metadata?: PublishableSkillMetadata | null;
  files?: PublishableSkillFiles | null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  return value ?? null;
}

export function normalizeSkillLabels(labels: string[] | null | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function normalizeSkillScripts(
  scripts: Array<{ name: string; content: string }> | null | undefined,
): Array<{ name: string; content: string }> {
  return [...(scripts ?? [])]
    .map((script) => ({ name: script.name, content: script.content }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.content.localeCompare(b.content));
}

export function arePublishableSkillMetadataEqual(
  current: PublishableSkillMetadata,
  next: PublishableSkillMetadata,
): boolean {
  return (
    normalizeOptionalString(current.name) === normalizeOptionalString(next.name) &&
    normalizeOptionalString(current.description) === normalizeOptionalString(next.description) &&
    normalizeOptionalString(current.type) === normalizeOptionalString(next.type) &&
    JSON.stringify(normalizeSkillLabels(current.labels)) === JSON.stringify(normalizeSkillLabels(next.labels))
  );
}

export function arePublishableSkillFilesEqual(
  current: PublishableSkillFiles,
  next: PublishableSkillFiles,
): boolean {
  return (
    normalizeOptionalString(current.specs) === normalizeOptionalString(next.specs) &&
    JSON.stringify(normalizeSkillScripts(current.scripts)) === JSON.stringify(normalizeSkillScripts(next.scripts))
  );
}

export function arePublishableSkillStatesEqual(
  current: PublishableSkillState,
  next: PublishableSkillState,
): boolean {
  return (
    arePublishableSkillMetadataEqual(current.metadata ?? {}, next.metadata ?? {}) &&
    arePublishableSkillFilesEqual(current.files ?? {}, next.files ?? {})
  );
}
