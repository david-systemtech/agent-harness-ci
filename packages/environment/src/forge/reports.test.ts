import { randomUUID } from "node:crypto";
import { GITHUB_ORIGIN, type ParamsOf } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, TOKEN } from "../../test/forge.js";
import { startTestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import type { ForgeFetch } from "./providers.js";
import { RELEASE_SOURCE } from "../updates/channel.js";
import { mediaMatches } from "./reports.js";

const { onCleanup } = useCleanups();
/** A report as the wire takes one, its arrays mutable as the params type has them, so `client.request` answers it typed. */
type Report = ParamsOf<"reports.submit">["report"];
const report: Report = { kind: "bug", level: "major", name: "Reporter", description: "The sidebar freezes.", client: { version: "0.1.0", kind: "desktop" }, attachments: [] };

it("publishes a report through the environment's GitHub credential and replays its receipt without another issue", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, { login: "reporter", id: 42 });
  forge.repository(TOKEN, RELEASE_SOURCE.repository);
  forge.answer(TOKEN, `POST /api/v3/repos/${RELEASE_SOURCE.repository}/issues`, { status: 201, body: { number: 17, title: "Bug: The sidebar freezes.", body: "report", state: "open", html_url: `https://github.com/${RELEASE_SOURCE.repository}/issues/17` } });
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  await added(client, { url: GITHUB_ORIGIN, kind: "github" });
  const params = { commandId: randomUUID(), report };
  const answer = await client.request("reports.submit", params);
  expect(answer.result?.number).toBe(17);
  expect((await client.request("reports.submit", params)).receipt).toEqual(answer.receipt);
  const posts = forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toMatchObject({ labels: ["bug", "severity:major"], body: expect.stringContaining("Reporter: Reporter") });
  expect(posts[0]?.body).toMatchObject({ body: expect.stringContaining("Client: desktop 0.1.0") });
});

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
const webm = Buffer.from([26, 69, 223, 163]).toString("base64");
const mediaReport: Report = { ...report, attachments: [{ name: "screenshot.png", mediaType: "image/png", content: png }, { name: "recording.webm", mediaType: "video/webm", content: webm }] };

const withGitHub = async (wrap: (fetch: ForgeFetch) => ForgeFetch = (fetch) => fetch) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, { login: "reporter", id: 42 });
  forge.repository(TOKEN, RELEASE_SOURCE.repository);
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, forgeFetch: wrap(forge.fetch) });
  onCleanup(() => t.close());
  const client = await t.client();
  await added(client, { url: GITHUB_ORIGIN, kind: "github" });
  return { forge, t, client };
};

it("uploads screenshots and videos to the user's public repository and links both in the issue", async () => {
  const repository = "reporter/agent-harness-report-attachments";
  const uploads: { url: string; body: unknown }[] = [];
  let created = false;
  let creation: unknown;
  const { forge, client } = await withGitHub((fetch) => async (url, init) => {
    if (url === `https://api.github.com/repos/${repository}`) return new Response(JSON.stringify(created ? { full_name: repository, private: false, default_branch: "main", html_url: `https://github.com/${repository}` } : { message: "Not Found" }), { status: created ? 200 : 404 });
    if (init.method === "POST" && url === "https://api.github.com/user/repos") {
      created = true;
      creation = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ full_name: repository, private: false, default_branch: "main", html_url: `https://github.com/${repository}` }), { status: 201 });
    }
    if (init.method === "PUT" && url.includes(`/repos/${repository}/contents/`)) {
      uploads.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ content: { path: "attachment" } }), { status: 201 });
    }
    return fetch(url, init);
  });
  forge.answer(TOKEN, `GET /api/v3/repos/${repository}`, { status: 200, body: { full_name: repository, private: false, default_branch: "main", html_url: `https://github.com/${repository}` } });
  forge.answer(TOKEN, `POST /api/v3/repos/${RELEASE_SOURCE.repository}/issues`, { status: 201, body: { number: 18, title: "Bug", body: "report", state: "open", html_url: `https://github.com/${RELEASE_SOURCE.repository}/issues/18` } });
  expect((await client.request("reports.submit", { commandId: randomUUID(), report: mediaReport })).result?.number).toBe(18);
  expect(creation).toMatchObject({ name: "agent-harness-report-attachments", private: false });
  expect(uploads).toHaveLength(2);
  expect(uploads[0]?.body).toMatchObject({ content: png, message: "Add report attachment" });
  expect(uploads[1]?.body).toMatchObject({ content: webm });
  const body = String((forge.requests.find((request) => request.method === "POST" && request.path.endsWith("/issues"))?.body as { body: string }).body);
  expect(body).toContain("![Screenshot 1](https://github.com/reporter/agent-harness-report-attachments/blob/main/reports/");
  expect(body).toContain("[Video 2](https://github.com/reporter/agent-harness-report-attachments/blob/main/reports/");
  expect(body).toContain("Environment:");
  expect(body).toContain(`(${process.platform}/${process.arch})`);

});

it("refuses a report without a GitHub account before making an external request", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  await expect(client.request("reports.submit", { commandId: randomUUID(), report })).rejects.toMatchObject({ code: "forge_account_missing" });
  expect(forge.requests).toHaveLength(0);
});

it("refuses invalid media and secrets before any attachment or issue is published", async () => {
  const { forge, client } = await withGitHub();
  const before = forge.requests.length;
  await expect(client.request("reports.submit", { commandId: randomUUID(), report: { ...report, attachments: [{ name: "fake.png", mediaType: "image/png", content: "dGVzdA==" }] } })).rejects.toMatchObject({ code: "invalid_params" });
  await expect(client.request("reports.submit", { commandId: randomUUID(), report: { ...report, description: `The token is ${TOKEN}`, attachments: mediaReport.attachments } })).rejects.toMatchObject({ code: "secret_shaped" });
  const metadata = Buffer.concat([Buffer.from(png, "base64"), Buffer.from(TOKEN)]).toString("base64");
  await expect(client.request("reports.submit", { commandId: randomUUID(), report: { ...report, attachments: [{ name: "metadata.png", mediaType: "image/png", content: metadata }] } })).rejects.toMatchObject({ code: "secret_shaped" });
  expect(forge.requests.slice(before).filter((request) => request.method !== "GET")).toHaveLength(0);
});

it("refuses a private attachment repository and a failed upload before creating an issue", async () => {
  const { forge, client } = await withGitHub();
  const repository = "reporter/agent-harness-report-attachments";
  forge.repository(TOKEN, repository);
  await expect(client.request("reports.submit", { commandId: randomUUID(), report: mediaReport })).rejects.toMatchObject({ code: "invalid_params" });
  forge.answer(TOKEN, `GET /api/v3/repos/${repository}`, { status: 200, body: { full_name: repository, private: false, default_branch: "main", html_url: `https://github.com/${repository}` } });
  // The forge's unscripted PUT rejects the upload.
  await expect(client.request("reports.submit", { commandId: randomUUID(), report: mediaReport })).rejects.toMatchObject({ code: "verification_failed" });
  expect(forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"))).toHaveLength(0);
});

it("takes a QuickTime movie that opens with any of its leading atoms, ftyp being optional, and an MP4 only with its ftyp", () => {
  const atom = (size: number, type: string) => Buffer.concat([Buffer.from([size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]), Buffer.from(type, "latin1")]);
  for (const type of ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]) expect(mediaMatches("video/quicktime", atom(8, type)), type).toBe(true);
  expect(mediaMatches("video/quicktime", atom(0, "mdat"))).toBe(true);
  expect(mediaMatches("video/quicktime", atom(1, "mdat"))).toBe(true);
  expect(mediaMatches("video/quicktime", atom(4, "moov"))).toBe(false);
  expect(mediaMatches("video/quicktime", atom(8, "RIFF"))).toBe(false);
  expect(mediaMatches("video/quicktime", Buffer.from("moov"))).toBe(false);
  expect(mediaMatches("video/mp4", atom(8, "ftyp"))).toBe(true);
  expect(mediaMatches("video/mp4", atom(8, "moov"))).toBe(false);
});
