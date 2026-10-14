import { randomUUID } from "node:crypto";
import { ContractError, ENVIRONMENT_STREAM_KIND, GITHUB_ORIGIN, REPORT_FILE_BYTES, invalidParams, type ParamsOf } from "@agent-harness/contracts";
import type { PreparedCommand } from "../serve/methods.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import { secretShapedIn } from "../scrub/refusal.js";
import { RELEASE_SOURCE } from "../updates/channel.js";
import type { ForgeService } from "./forge-service.js";
import type { ForgeAnswer } from "./operations.js";

const ATTACHMENT_REPOSITORY = "agent-harness-report-attachments";
const EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
const text = (value: string) => value.replace(/[\\`*_{}[\]<>#]/g, "\\$&").replace(/[\r\n]/g, " ");

/** Refusals keep their typed guidance; failed uploads stop before an issue promises attachments. */
const valueOf = <T>(answer: ForgeAnswer<T>): T => {
  if (answer.outcome === "done") return answer.value;
  if (answer.outcome === "refused") throw new ContractError(answer.error);
  if (answer.outcome === "unreachable") throw new ContractError({ code: "unreachable", message: answer.message, data: { origin: GITHUB_ORIGIN } });
  throw new ContractError({ code: "verification_failed", message: `GitHub refused the report operation (HTTP ${answer.status}). Check the GitHub account's issue and contents permissions in Settings → Forges.`, data: { origin: GITHUB_ORIGIN, status: answer.status } });
};

/**
 * The atoms a QuickTime movie may open with: its `ftyp` is optional (Apple's
 * QuickTime File Format, "File type compatibility atom"), so an older movie
 * opens with its movie data, its movie atom, or free space before them.
 */
const QUICKTIME_LEADING_ATOMS: ReadonlySet<string> = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);

/** Whether `bytes` open with a QuickTime atom: a size that can be one (0 to the end, 1 for a 64-bit size, else at least its own 8-byte header) and a leading atom's type. */
const opensWithQuickTimeAtom = (bytes: Buffer): boolean => {
  if (bytes.length < 8) return false;
  const size = bytes.readUInt32BE(0);
  return (size === 0 || size === 1 || size >= 8) && QUICKTIME_LEADING_ATOMS.has(bytes.subarray(4, 8).toString("latin1"));
};

/** Check media signatures before writing anything to the public repository. */
export const mediaMatches = (mediaType: string, bytes: Buffer): boolean => {
  switch (mediaType) {
    case "image/png": return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "image/gif": return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp": return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "video/mp4": return bytes.subarray(4, 8).toString("ascii") === "ftyp";
    case "video/quicktime": return opensWithQuickTimeAtom(bytes);
    case "video/webm": return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    default: return false;
  }
};

/** The wire's prepared command supplies receipt deduplication across socket retries. */
export const reportCommand = (forge: ForgeService, options: { readonly environmentId: string; readonly version: string; readonly scrub: ScrubRegistry }): PreparedCommand<"reports.submit"> => ({
  async prepare(params: ParamsOf<"reports.submit">) {
    const { report } = params;
    const account = forge.list().find((held) => held.kind === "github" && held.origin === GITHUB_ORIGIN);
    if (account?.identity === null || account === undefined) throw new ContractError({ code: "forge_account_missing", message: "Connect a GitHub account in Settings → Forges on this environment to submit a report.", data: { origin: GITHUB_ORIGIN, step: "forges" } });
    const secret = secretShapedIn(options.scrub, "report", { name: report.name, description: report.description, version: report.client.version, ...Object.fromEntries(report.attachments.map((file, index) => [`attachment ${index + 1}`, file.name])) }, "Nothing was published.");
    if (secret !== null) throw new ContractError(secret);
    for (const file of report.attachments) {
      const bytes = Buffer.from(file.content, "base64");
      const mediaSecret = secretShapedIn(options.scrub, "report", { "attachment metadata": bytes.toString("utf8") }, "Nothing was published.");
      if (mediaSecret !== null) throw new ContractError(mediaSecret);
      if (bytes.length > REPORT_FILE_BYTES || bytes.toString("base64") !== file.content || !mediaMatches(file.mediaType, bytes)) throw new ContractError(invalidParams([], "Use valid PNG, JPEG, GIF, WebP, MP4, WebM or MOV files, at most 5 MiB each."));
    }
    const target = { origin: GITHUB_ORIGIN, purpose: "submit a public report" };
    // Prove access to the issue target before creating an attachment repository.
    valueOf(await forge.repositories.get({ ...target, repository: RELEASE_SOURCE.repository }));
    const links: string[] = [];
    if (report.attachments.length > 0) {
      const repository = `${account.identity.login}/${ATTACHMENT_REPOSITORY}`;
      const existing = await forge.repositories.get({ ...target, repository });
      const uploads = existing.outcome === "failed" && existing.status === 404
        ? valueOf(await forge.repositories.create({ ...target, name: ATTACHMENT_REPOSITORY, private: false, description: "Public screenshots and videos linked from reports." }))
        : valueOf(existing);
      if (uploads.private) throw new ContractError(invalidParams([], "The report attachment repository must be public so readers can see the attachments."));
      const uploadId = randomUUID();
      for (const [index, file] of report.attachments.entries()) {
        const path = `reports/${uploadId}/${index + 1}.${EXTENSIONS[file.mediaType]}`;
        valueOf(await forge.repositories.upload({ ...target, repository, path, content: file.content }));
        const url = `https://github.com/${repository}/blob/${encodeURIComponent(uploads.defaultBranch)}/${path}?raw=true`;
        links.push(file.mediaType.startsWith("image/") ? `![Screenshot ${index + 1}](${url})` : `[Video ${index + 1}](${url})`);
      }
    }
    const heading = report.kind === "bug" ? "Bug" : "Feature";
    const priority = report.kind === "bug" ? "Severity" : "Importance";
    const body = `Reporter: ${text(report.name)}\nType: ${heading}\n${priority}: ${report.level}\nEnvironment: ${text(options.version)} (${process.platform}/${process.arch})\nClient: ${report.client.kind} ${text(report.client.version)}\n\n## Description\n\n${report.description}\n${links.length > 0 ? `\n## Attachments\n\n${links.join("\n\n")}\n` : ""}`;
    const issue = valueOf(await forge.issues.create({ ...target, repository: RELEASE_SOURCE.repository, title: `${heading}: ${report.description.split(/\r?\n/)[0]?.slice(0, 120)}`, body, labels: [report.kind, `${priority.toLowerCase()}:${report.level}`] }));
    const result = { number: issue.number, url: issue.url };
    return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, result });
  },
});
