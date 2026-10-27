/**
 * Thrown when the caller supplied images but the selected model has no image input.
 * The turn fails instead of silently running text-only as if no image was sent.
 * Model fallback skips such a candidate and tries the next one; only when no remaining
 * candidate accepts images does this error end the turn.
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
