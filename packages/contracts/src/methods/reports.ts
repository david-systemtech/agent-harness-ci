import { z } from "zod";
import { SecretShapedError } from "../shape-rules.js";
import { commandParams, defineMethod } from "../method.js";
import { CredentialUnavailableError } from "../git-credential.js";
import { ForgeAccountMissingError, ForgeUnreachableError, VerificationFailedError } from "./forge.js";

/** Keep the base64 request below the wire's 16 MiB frame limit. */
export const REPORT_FILE_BYTES = 5 * 1024 * 1024;
export const REPORT_TOTAL_BYTES = 9 * 1024 * 1024;
export const REPORT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"] as const;

const decodedBytes = (content: string) => content.length / 4 * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
const attachment = z.object({
  name: z.string().trim().min(1).max(120).regex(/^[\w .()-]+$/),
  mediaType: z.enum(REPORT_MEDIA_TYPES).meta({ description: "The image or video media type of a public report attachment." }),
  content: z.string().min(4).max(4 * Math.ceil(REPORT_FILE_BYTES / 3)).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((content) => content.length % 4 === 0, "Use base64 encoded media.").refine((content) => decodedBytes(content) <= REPORT_FILE_BYTES, "Each attachment must be at most 5 MiB."),
});
const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(20000),
  client: z.object({ version: z.string().min(1).max(80), kind: z.enum(["desktop", "web", "gui"]).meta({ description: "The client submitting the report: desktop window, browser tab, or another GUI client." }) }),
  attachments: z.array(attachment).max(4).refine((files) => files.reduce((sum, file) => sum + decodedBytes(file.content), 0) <= REPORT_TOTAL_BYTES, "Attachments must total at most 9 MiB."),
};

/** Public reporting is an explicit admin command, never an offline outbox write. */
export const reportsSubmit = defineMethod({
  name: "reports.submit",
  scope: "admin",
  kind: "command",
  params: commandParams({ report: z.discriminatedUnion("kind", [
    z.object({ ...fields, kind: z.literal("bug"), level: z.enum(["critical", "major", "minor"]).meta({ description: "Bug severity: critical prevents use, major blocks a task, minor is a lesser defect." }) }),
    z.object({ ...fields, kind: z.literal("feature"), level: z.enum(["high", "medium", "low"]).meta({ description: "Feature importance to the reporter: high, medium, or low." }) }),
  ]) }),
  result: z.object({ number: z.int().positive(), url: z.url() }),
  errors: [ForgeAccountMissingError, CredentialUnavailableError, VerificationFailedError, ForgeUnreachableError, SecretShapedError],
});
