import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";

const expect = browserExpect.configure({ timeout: 60_000 });
interface LinkedSession { readonly id: string; readonly title: string }

/** Ordinary same-document links, independent of startup and service-worker messages. */
export async function webSessionRouteSmoke(page: Page, engine: string, environmentId: string, first: LinkedSession, second: LinkedSession, liveReply?: string): Promise<void> {
  const documentStarted = await page.evaluate("performance.timeOrigin");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const follow = async (session: LinkedSession) => {
    const hash = `#/session/${encodeURIComponent(environmentId)}/${encodeURIComponent(session.id)}`;
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await expect(page.locator("[data-header-session-title]")).toHaveText(session.title);
    await expect(message).toBeVisible();
    assert.equal(new URL(page.url()).hash, hash, "The header and URL name the same session.");
    assert.equal(await page.evaluate("performance.timeOrigin"), documentStarted, "A session link reloads no document.");
  };
  await follow(first);
  if (liveReply) await expect(page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: liveReply }).last()).toBeVisible();
  await message.fill("First session route draft");
  await follow(second);
  if (liveReply) await expect(page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: liveReply })).toBeHidden();
  await message.fill("Second session route draft");
  await follow(first);
  await expect(message).toHaveValue("First session route draft");
  if (liveReply) {
    await expect(page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: liveReply }).last()).toBeVisible();
  }
  await follow(second);
  await expect(message).toHaveValue("Second session route draft");
  await message.fill("");
  await follow(first);
  await message.fill("");
  // Send and Stop share the composer action: a retained draft offers Send even during a live run.
  if (liveReply) await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();
  console.log(`WEB-SESSION-ROUTE PASS ${engine}: same document, header, composer, drafts${liveReply ? ", live transcript and run" : ""}`);
}
