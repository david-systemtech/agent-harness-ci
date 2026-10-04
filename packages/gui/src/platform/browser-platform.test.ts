import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { browserPlatform } from "./browser-platform.js";

const viewWith = (indexedDB: IDBFactory) => Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB });
describe("the browser's runtime platform", () => {
  it("remembers paired credentials and documents separately across reload, and Forget erases the credential", async () => {
    const db = new IDBFactory();
    const first = browserPlatform(viewWith(db), "0.0.0");
    await first.secrets.set("environment-one", "token-for-tests");
    await first.documents.set("connections", { address: "https://web.example" });
    const reload = browserPlatform(viewWith(db), "0.0.0");
    expect(await reload.secrets.get("environment-one")).toBe("token-for-tests");
    expect(await reload.documents.get("connections")).toEqual({ address: "https://web.example" });
    expect(await reload.documents.get("environment-one")).toBeUndefined();
    await reload.secrets.delete("environment-one");
    expect(await first.secrets.get("environment-one")).toBeUndefined();
    expect(first.shell).toBeUndefined(); expect(first.grant).toBeUndefined();
  });

  it("pairs for this visit when storage is denied, visibly reporting persistence loss without logging credentials", async () => {
    const db = new IDBFactory(); vi.spyOn(db, "open").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    const platform = browserPlatform(viewWith(db), "0.0.0");
    await platform.secrets.set("environment-one", "token-for-tests");
    await platform.documents.set("connections", { address: "https://web.example" });
    expect(await platform.secrets.get("environment-one")).toBe("token-for-tests");
    expect(platform.persistence.read()).toBe("visit-only");
    await platform.secrets.delete("environment-one");
    expect(await platform.secrets.get("environment-one")).toBeUndefined();
    const reload = browserPlatform(viewWith(db), "0.0.0");
    expect(await reload.secrets.get("environment-one")).toBeUndefined();
  });
});
