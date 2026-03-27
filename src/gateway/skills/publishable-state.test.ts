import { describe, expect, it } from "vitest";
import {
  arePublishableSkillFilesEqual,
  arePublishableSkillMetadataEqual,
  arePublishableSkillStatesEqual,
} from "./publishable-state.js";

describe("publishable-state", () => {
  it("treats identical metadata as equal", () => {
    expect(
      arePublishableSkillMetadataEqual(
        {
          name: "cluster-events",
          description: "Inspect cluster events",
          type: "Custom",
          labels: ["kubernetes", "diagnostic"],
        },
        {
          name: "cluster-events",
          description: "Inspect cluster events",
          type: "Custom",
          labels: ["kubernetes", "diagnostic"],
        },
      ),
    ).toBe(true);
  });

  it("treats label order and duplicates as no-op", () => {
    expect(
      arePublishableSkillMetadataEqual(
        { labels: ["kubernetes", "diagnostic"] },
        { labels: ["diagnostic", "kubernetes", "diagnostic"] },
      ),
    ).toBe(true);
  });

  it("detects metadata changes", () => {
    expect(
      arePublishableSkillMetadataEqual(
        { name: "cluster-events", description: "Inspect cluster events", type: "Custom", labels: ["kubernetes"] },
        { name: "cluster-events", description: "Inspect event storms", type: "Custom", labels: ["kubernetes"] },
      ),
    ).toBe(false);
  });

  it("treats identical files as equal", () => {
    expect(
      arePublishableSkillFilesEqual(
        {
          specs: "---\nname: cluster-events\n---\nRun checks",
          scripts: [{ name: "run.sh", content: "echo ok" }],
        },
        {
          specs: "---\nname: cluster-events\n---\nRun checks",
          scripts: [{ name: "run.sh", content: "echo ok" }],
        },
      ),
    ).toBe(true);
  });

  it("treats script order as no-op", () => {
    expect(
      arePublishableSkillFilesEqual(
        {
          specs: "same",
          scripts: [
            { name: "b.sh", content: "echo b" },
            { name: "a.sh", content: "echo a" },
          ],
        },
        {
          specs: "same",
          scripts: [
            { name: "a.sh", content: "echo a" },
            { name: "b.sh", content: "echo b" },
          ],
        },
      ),
    ).toBe(true);
  });

  it("detects script content changes", () => {
    expect(
      arePublishableSkillFilesEqual(
        {
          specs: "same",
          scripts: [{ name: "run.sh", content: "echo old" }],
        },
        {
          specs: "same",
          scripts: [{ name: "run.sh", content: "echo new" }],
        },
      ),
    ).toBe(false);
  });

  it("treats null and undefined as equal for optional fields", () => {
    expect(
      arePublishableSkillFilesEqual(
        { specs: undefined, scripts: undefined },
        { specs: null, scripts: null },
      ),
    ).toBe(true);
    expect(
      arePublishableSkillMetadataEqual(
        { description: undefined, labels: undefined },
        { description: null, labels: null },
      ),
    ).toBe(true);
  });

  it("detects metadata-only state changes", () => {
    expect(
      arePublishableSkillStatesEqual(
        {
          metadata: { name: "cluster-events", type: "Custom", labels: ["kubernetes"] },
          files: { specs: "same", scripts: [{ name: "run.sh", content: "echo ok" }] },
        },
        {
          metadata: { name: "cluster-events", type: "Network", labels: ["kubernetes"] },
          files: { specs: "same", scripts: [{ name: "run.sh", content: "echo ok" }] },
        },
      ),
    ).toBe(false);
  });
});
