/**
 * The pictures a tool call returned (docs/specs/gui.md, "A session pane":
 * images inline), read out of its output as the provider gave it: a content
 * block of a picture in base64 (`{type: "image", source: {type: "base64",
 * media_type, data}}`, alone or in a list), or the structured result a read
 * of a picture file gives (`{type: "image", file: {base64, type}}`). Only the
 * picture types a provider takes are drawn; everything else in the output is
 * the output's text (`withoutPictures`), so a picture never hides the words
 * beside it.
 */

export interface Picture {
  readonly mediaType: string;
  /** Its bytes, in base64. */
  readonly data: string;
}

const DRAWN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** How deep into an output the pictures are looked for: a list of blocks, a block, its source. */
const DEPTH = 4;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;

const pictureOf = (block: Readonly<Record<string, unknown>>): Picture | undefined => {
  if (block["type"] !== "image") return undefined;
  const source = record(block["source"]);
  const file = record(block["file"]);
  const mediaType = source?.["type"] === "base64" ? source["media_type"] : file?.["type"];
  const data = source?.["type"] === "base64" ? source["data"] : file?.["base64"];
  return typeof mediaType === "string" && DRAWN.has(mediaType) && typeof data === "string" && data.length > 0 ? { mediaType, data } : undefined;
};

/** Every picture in `output`, in the order it holds them. */
export const picturesIn = (output: unknown, depth = DEPTH): readonly Picture[] => {
  if (depth === 0) return [];
  if (Array.isArray(output)) return output.flatMap((item) => picturesIn(item, depth - 1));
  const block = record(output);
  if (block === undefined) return [];
  const picture = pictureOf(block);
  if (picture !== undefined) return [picture];
  return Object.values(block).flatMap((value) => picturesIn(value, depth - 1));
};

/** A picture as an image's source. */
export const pictureUrl = (picture: Picture): string => `data:${picture.mediaType};base64,${picture.data}`;

/** `output` with its pictures taken out, what else it holds kept as it was; undefined when nothing else is left. */
export const withoutPictures = (output: unknown, depth = DEPTH): unknown => {
  if (depth === 0) return output;
  if (Array.isArray(output)) {
    const kept = output.map((item) => withoutPictures(item, depth - 1)).filter((item) => item !== undefined);
    return kept.length === 0 && output.length > 0 ? undefined : kept;
  }
  const block = record(output);
  if (block === undefined) return output;
  if (pictureOf(block) !== undefined) return undefined;
  const entries = Object.entries(block);
  const kept = entries.map(([key, value]) => [key, withoutPictures(value, depth - 1)] as const).filter(([, value]) => value !== undefined);
  return kept.length === 0 && entries.length > 0 ? undefined : Object.fromEntries(kept);
};
