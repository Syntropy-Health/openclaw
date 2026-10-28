/**
 * Thrown when the caller supplied images but the selected model has no image input.
 * The turn fails instead of silently running text-only as if no image was sent.
 * Two sources: the model-fallback runner throws it up front when filtering out text-only
 * candidates leaves none; the embedded runner throws it (defence in depth) if a text-only
 * model is reached anyway. The fallback loop treats the latter as a normal failure.
 */
export class ImageInputUnsupportedError extends Error {
  readonly code = "image_input_unsupported";
  readonly imageCount: number;

  constructor(imageCount: number) {
    super(
      `model does not accept image input (${imageCount} image${imageCount === 1 ? "" : "s"} supplied)`,
    );
    this.name = "ImageInputUnsupportedError";
    this.imageCount = imageCount;
  }
}

/** Code-based check, so it also matches across module instances. */
export function isImageInputUnsupportedError(err: unknown): err is ImageInputUnsupportedError {
  return (
    err instanceof ImageInputUnsupportedError ||
    (Boolean(err) &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "image_input_unsupported")
  );
}
