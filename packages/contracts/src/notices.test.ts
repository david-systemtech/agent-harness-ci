import { describe, expect, it } from "vitest";
import { validEnvironmentStartedEvent } from "../test/fixtures.js";
import { ENVIRONMENT_NOTICE_TYPES, ENVIRONMENT_STREAM_KIND, EnvironmentNotice, EventEnvelope } from "./index.js";

describe("environment notices", () => {
  it("are started, updated and draining, an account updated (#134), the sign-in's state and executable (#135), a prompt parked and resolved (#130), and an account's usage updated (#136), on the environment stream", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toEqual([
      "environment.started",
      "environment.updated",
      "environment.draining",
      "account.updated",
      "signin.updated",
      "signin.executable-chosen",
      "prompt.parked",
      "prompt.resolved",
      "usage.updated",
    ]);
    expect(ENVIRONMENT_STREAM_KIND).toBe("environment");
  });

  it("parse from the event envelope an event frame carries, the envelope's other fields left aside", () => {
    const event = EventEnvelope.parse(validEnvironmentStartedEvent);
    expect(EnvironmentNotice.parse(event)).toEqual({
      type: "environment.started",
      payload: { harnessVersion: "0.1.0", protocolVersion: 1 },
    });
  });
});
