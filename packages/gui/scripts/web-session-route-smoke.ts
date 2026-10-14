import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";

const expect = browserExpect.configure({ timeout: 60_000 });
interface LinkedSession { readonly id: string; readonly title: string }

/**
 * Ordinary same-document links, independent of startup and service-worker messages.
 * The caller owns the sessions: drafts are shared through the environment (last write wins), so
 * another open page that keeps a draft in either session can overwrite the one typed here (#2187).
 * A failure names the page and the session it was on.
 */
export async function webSessionRouteSmoke(page: Page, engine: string, environmentId: string, first: LinkedSession, second: LinkedSession, liveReply?: string): Promise<void> {
  let on = "before the first link";
  try { await routeSmoke(page, engine, environmentId, first, second, liveReply, (session, step) => { on = `session "${session.title}" (${session.id}), ${step}`; }); }
  catch (error) {
    console.error(`WEB-SESSION-ROUTE FAIL ${engine}: page "${engine}" on ${on}`);
    throw new Error(`Session route smoke failed on page "${engine}", ${on}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function routeSmoke(page: Page, engine: string, environmentId: string, first: LinkedSession, second: LinkedSession, liveReply: string | undefined, at: (session: LinkedSession, step: string) => void): Promise<void> {
  const documentStarted = await page.evaluate("performance.timeOrigin");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const follow = async (session: LinkedSession) => {
    at(session, "following its link");
    const hash = `#/session/${encodeURIComponent(environmentId)}/${encodeURIComponent(session.id)}`;
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await expect(page.locator("[data-header-session-title]")).toHaveText(session.title);
    await expect(message).toBeVisible();
    assert.equal(new URL(page.url()).hash, hash, "The header and URL name the same session.");
    assert.equal(await page.evaluate("performance.timeOrigin"), documentStarted, "A session link reloads no document.");
    at(session, "on the session");
  };
  await follow(first);
  if (liveReply) await expect(page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: liveReply }).last()).toBeVisible();
  await message.fill("First session route draft");
  await follow(second);
  if (liveReply) await expect(page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: liveReply })).toBeHidden();
  await message.fill("Second session route draft");
  await follow(first);
  at(first, 'expecting its draft "First session route draft"');
  await expect(message).toHaveValue("First session route draft");
  if (liveReply) {
    await expect(page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: liveReply }).last()).toBeVisible();
  }
  await follow(second);
  at(second, 'expecting its draft "Second session route draft"');
  await expect(message).toHaveValue("Second session route draft");
  await message.fill("");
  await follow(first);
  await message.fill("");
  // Send and Stop share the composer action: a retained draft offers Send even during a live run.
  if (liveReply) await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();
  console.log(`WEB-SESSION-ROUTE PASS ${engine}: same document, header, composer, drafts${liveReply ? ", live transcript and run" : ""}`);
}
