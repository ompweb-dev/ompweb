import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");

const { SessionLink } = await import("./SessionLink.tsx");

test.afterEach(cleanup);

const session = {
  id: "source-session",
  name: "Incident review",
  hostId: "worker-1",
  hostLabel: "Worker 1",
};

test("plain clicks open the host-qualified session while modified clicks stay browser-native", () => {
  const opened = [];
  const listener = (event) => opened.push(event.detail);
  window.addEventListener("omp-open-session", listener);
  try {
    render(React.createElement(SessionLink, { session }));
    const link = screen.getByRole("link", { name: "Open session Incident review on Worker 1" });
    assert.match(link.getAttribute("href"), /session=source-session/);
    assert.match(link.getAttribute("href"), /host=worker-1/);
    assert.equal(fireEvent.click(link), false, "plain navigation is handled in-app");
    assert.deepEqual(opened, [{ sessionId: "source-session", hostId: "worker-1" }]);
    fireEvent.click(link, { ctrlKey: true });
    assert.equal(opened.length, 1);
  } finally {
    window.removeEventListener("omp-open-session", listener);
  }
});

test("untitled sessions never expose their UUID as the visible label", () => {
  render(React.createElement(SessionLink, { session: { ...session, name: null, cwd: "/srv/app", createdAt: "2026-11-15T12:41:00.000Z" } }));
  const link = screen.getByRole("link");
  assert.match(link.textContent, /^Untitled session · app · /);
  assert.doesNotMatch(link.textContent, /source-session/);
});
