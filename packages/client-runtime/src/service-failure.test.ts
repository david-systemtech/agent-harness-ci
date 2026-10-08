import { describe, expect, it } from "vitest";
import { SERVICE_FAILURE_KINDS, ServiceFailureError, serviceFailureOf } from "./service-failure.js";

describe("serviceFailureOf", () => {
  it.each(SERVICE_FAILURE_KINDS)("reads the %s kind and the desktop's text back from the message Electron IPC keeps", (kind) => {
    const thrown = new ServiceFailureError(kind, "Could not start the environment on this machine: no user manager.");
    const crossed = new Error(`Error invoking remote method 'shell:service.start': Error: ${thrown.message}`);
    expect(serviceFailureOf(thrown)).toEqual({ kind, text: "Could not start the environment on this machine: no user manager." });
    expect(serviceFailureOf(crossed)).toEqual({ kind, text: "Could not start the environment on this machine: no user manager." });
  });

  it("keeps a text over several lines whole", () => {
    expect(serviceFailureOf(new ServiceFailureError("install", "first\nsecond"))).toEqual({ kind: "install", text: "first\nsecond" });
  });

  it("reads nothing from a failure that names no kind, or names one it does not know", () => {
    expect(serviceFailureOf(new Error("Could not read service status."))).toBeUndefined();
    expect(serviceFailureOf(new Error("[service exploded] text"))).toBeUndefined();
    expect(serviceFailureOf("[service start] a string, not an error")).toBeUndefined();
  });
});
