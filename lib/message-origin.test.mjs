import assert from "node:assert/strict";
import test from "node:test";

const {
  ORIGIN_MAX_BYTES,
  formatSessionOriginHeader,
  parseMessageOrigin,
  splitOriginHeader,
} = await import("./message-origin.ts");

const sessionOrigin = {
  v: 1,
  kind: "session",
  sentAt: "2026-11-15T12:41:00.000Z",
  session: {
    id: "01a1c9d8-4206-736f-b9cf-ebccf7912207",
    name: "Incident review",
    hostId: "worker-1",
    hostLabel: "Worker 1",
    cwd: "/srv/app",
    createdAt: "2026-11-15T10:00:00.000Z",
    tool: "send_to_session",
    delivery: "followUp",
  },
};

const githubOrigin = {
  v: 1,
  kind: "github",
  sentAt: "2026-11-15T12:42:00.000Z",
  github: {
    repo: "ompweb-dev/ompweb",
    number: 503,
    target: "pr",
    url: "https://github.com/ompweb-dev/ompweb/pull/503",
    events: [{ kind: "review", author: "coderabbitai", bot: true, state: "changes requested" }],
  },
};

test("accepts bounded server origin variants and strips unknown-kind payloads", () => {
  assert.deepEqual(parseMessageOrigin(sessionOrigin), sessionOrigin);
  assert.deepEqual(parseMessageOrigin(githubOrigin), githubOrigin);
  assert.deepEqual(parseMessageOrigin({
    v: 1,
    kind: "future",
    sentAt: "2026-11-15T12:43:00.000Z",
    untrusted: { html: "<script>" },
  }), {
    v: 1,
    kind: "future",
    sentAt: "2026-11-15T12:43:00.000Z",
  });
});

test("drops malformed known origins and anything above the byte budget", () => {
  for (const invalid of [
    null,
    { v: 2, kind: "session", sentAt: sessionOrigin.sentAt, session: sessionOrigin.session },
    { v: 1, kind: "session", sentAt: sessionOrigin.sentAt, session: { ...sessionOrigin.session, delivery: "later" } },
    { v: 1, kind: "github", sentAt: githubOrigin.sentAt, github: { ...githubOrigin.github, url: "javascript:alert(1)" } },
    { v: 1, kind: "github", sentAt: githubOrigin.sentAt, github: { ...githubOrigin.github, events: [{ kind: "review", author: 42 }] } },
    { v: 1, kind: "future", sentAt: sessionOrigin.sentAt, padding: "x".repeat(ORIGIN_MAX_BYTES) },
  ]) {
    assert.equal(parseMessageOrigin(invalid), null);
  }
});

test("formats the model header and separates only its exact shape", () => {
  const header = `[Message from omp-web session "Incident review" (session id 01a1c9d8-4206-736f-b9cf-ebccf7912207, host Worker 1, delivery follow-up).\nIt was sent by another agent session, not by the user. Reply with send_to_session to that session id.]`;
  assert.equal(formatSessionOriginHeader(sessionOrigin), header);
  assert.deepEqual(splitOriginHeader(`${header}\n\nThe build passed.`), { header, body: "The build passed." });
  assert.equal(splitOriginHeader(`[Message from elsewhere]\n\nThe build passed.`), null);
});

test("formats unnamed sessions and every delivery label without exposing an empty name", () => {
  const labels = { prompt: "new turn", steer: "steer", followUp: "follow-up" };
  for (const [delivery, label] of Object.entries(labels)) {
    const origin = { ...sessionOrigin, session: { ...sessionOrigin.session, name: null, delivery } };
    assert.match(formatSessionOriginHeader(origin), new RegExp(`^\\[Message from an unnamed omp-web session .*delivery ${label.replace("-", "\\-")}\\)\\.`));
  }
});
