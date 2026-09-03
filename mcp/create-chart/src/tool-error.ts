export type VisualToolErrorKind = "input" | "configuration" | "renderer" | "internal";

export class VisualToolInputError extends Error {
  readonly kind = "input" as const;
}

export class VisualToolRendererError extends Error {
  readonly kind = "renderer" as const;
}

export class VisualToolConfigurationError extends Error {
  readonly kind = "configuration" as const;
}

export function visualToolErrorResponse(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { error_kind: VisualToolErrorKind };
} {
  const message = err instanceof Error ? err.message : String(err);
  const errorKind: VisualToolErrorKind = err instanceof VisualToolInputError
    ? "input"
    : err instanceof VisualToolConfigurationError
      ? "configuration"
    : err instanceof VisualToolRendererError
      ? "renderer"
      : "internal";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error_kind: errorKind },
  };
}

export function rendererError(err: unknown): VisualToolRendererError | VisualToolConfigurationError {
  if (err instanceof VisualToolRendererError || err instanceof VisualToolConfigurationError) return err;
  return new VisualToolRendererError(err instanceof Error ? err.message : String(err));
}
