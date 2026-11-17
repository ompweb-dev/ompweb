import assert from "node:assert/strict";
import test from "node:test";

const { readQueueSnapshot } = await import("./client-message-ids.ts");

const origin = {
  v: 1, kind: "session", sentAt: "2026-11-15T12:41:00.000Z",
  session: { id: "source", name: "Source", hostId: "local", hostLabel: "This machine", tool: "send_to_session", delivery: "prompt" },
};

test("queue snapshots keep only aligned valid message origins", () => {
  assert.deepEqual(readQueueSnapshot({
    steering: ["first", 42, "second"],
    followUp: ["later"],
    messageOrigins: {
      steering: [origin, origin, { v: 2, kind: "session" }],
      followUp: [origin],
    },
  }), {
    steering: ["first", "second"],
    followUp: ["later"],
    messageOrigins: { steering: [origin, null], followUp: [origin] },
  });
});
