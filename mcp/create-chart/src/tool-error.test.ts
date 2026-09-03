import { describe, expect, it } from "vitest";
import {
  VisualToolConfigurationError,
  VisualToolInputError,
  VisualToolRendererError,
  visualToolErrorResponse,
} from "./tool-error.js";

describe("visualToolErrorResponse", () => {
  it("marks model argument validation separately from renderer failures", () => {
    expect(visualToolErrorResponse(new VisualToolInputError("bad arguments"))).toMatchObject({
      isError: true,
      structuredContent: { error_kind: "input" },
    });
    expect(visualToolErrorResponse(new VisualToolRendererError("page unavailable"))).toMatchObject({
      isError: true,
      structuredContent: { error_kind: "renderer" },
    });
    expect(visualToolErrorResponse(new VisualToolConfigurationError("missing URL"))).toMatchObject({
      isError: true,
      structuredContent: { error_kind: "configuration" },
    });
  });

  it("does not mislabel unexpected implementation errors as renderer outages", () => {
    expect(visualToolErrorResponse(new Error("unexpected"))).toMatchObject({
      isError: true,
      structuredContent: { error_kind: "internal" },
    });
  });
});
