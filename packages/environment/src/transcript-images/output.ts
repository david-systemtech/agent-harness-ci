import { recordedImage, type RecordedImage } from "../adapter/contract.js";

export type RecordPicture = (mediaType: string, data: string) => RecordedImage;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Replace tool image bytes before they enter the log; retain text and structured file metadata. */
export const recordToolImages = (value: unknown, retain?: RecordPicture): unknown => {
  if (Array.isArray(value)) return value.map((item) => recordToolImages(item, retain));
  if (!record(value)) return value;
  if (value["type"] === "image") {
    const source = value["source"];
    const file = value["file"];
    const data = record(source) && source["type"] === "base64" ? source["data"] : record(file) ? file["base64"] : value["data"];
    const mediaType = record(source) ? source["media_type"] : record(file) ? file["type"] : value["mimeType"];
    if (typeof data === "string") {
      const type = typeof mediaType === "string" ? mediaType : "application/octet-stream";
      const image = retain?.(type, data) ?? recordedImage(type, Buffer.byteLength(data, "base64"));
      if (record(file)) {
        const metadata = { ...file };
        delete metadata["base64"];
        return { ...value, file: { ...metadata, mediaType: image.mediaType, size: image.size }, ...(retain === undefined ? {} : image) };
      }
      return image;
    }
  }
  if (value["type"] === "pdf" && record(value["file"]) && typeof value["file"]["base64"] === "string") {
    const { base64, ...file } = value["file"];
    return { ...value, file: { ...file, mediaType: "application/pdf", size: Buffer.byteLength(base64, "base64") } };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recordToolImages(item, retain)]));
};
