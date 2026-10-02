import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AccountIdentity, type AccountIdentity as Identity } from "@agent-harness/contracts";

/** A cached config is metadata, never a credential store. Bound its bytes as well as the service's read time. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Read only the identity cached by the CLI in oauthAccount. Unlike auth
 * status this starts no provider process and cannot refresh credentials.
 * A cached identity says who the directory belongs to, not whether a Run
 * can authenticate now. The normal Account status read owns that decision.
 */
export const readClaudeDirectoryIdentity = async (directory: string, home: string): Promise<Identity | null> => {
  const candidates = resolve(directory) === resolve(home, ".claude") ? [join(home, ".claude.json"), join(directory, ".claude.json")] : [join(directory, ".claude.json")];
  for (const path of candidates) {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new Error("The directory's cached identity could not be read.");
    });
    if (file === null) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error("The directory's identity config is not a bounded regular file.");
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) throw new Error("The directory's identity config exceeds the read bound.");
      let value: unknown;
      try { value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
      catch { throw new Error("The directory's identity config is not readable JSON."); }
      if (typeof value !== "object" || value === null || !("oauthAccount" in value)) return null;
      const account = value.oauthAccount;
      if (typeof account !== "object" || account === null || !("emailAddress" in account)) return null;
      const identity = AccountIdentity.safeParse({ provider: "claude", email: account.emailAddress, organisation: "organizationName" in account ? account.organizationName : null });
      if (!identity.success) throw new Error("The directory's cached identity is invalid.");
      return identity.data;
    } finally {
      await file.close();
    }
  }
  return null;
};
