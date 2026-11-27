import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";
import React from "react";

const { act, cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { ChatInput } = await import("./ChatInput.tsx");

// jsdom 29 ships no matchMedia, and the composer reads one at mount for the
// word-completion default (`(pointer: fine)`). Never match: desktop composer.
window.matchMedia = (media) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

async function renderComposer(t, props = {}) {
  const sent = [];
  const view = render(React.createElement(ChatInput, {
    async onSend(message) { sent.push(message); return { status: "accepted" }; },
    onThinkingLevelChange() {},
    configuredThinkingLevel: "auto",
    isStreaming: false,
    ...props,
  }));
  t.after(() => cleanup());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { view, sent };
}

const expandButton = (view) => view.getByRole("button", { name: /Expand editor|chatInput\.expandEditor/ });

test("the composer opens a full-screen editor that shares its draft", async (t) => {
  const { view } = await renderComposer(t);
  assert.equal(view.queryByRole("dialog"), null, "the editor must start closed");
  fireEvent.click(expandButton(view));
  const dialog = view.getByRole("dialog");
  const editor = dialog.querySelector("textarea");
  assert.ok(editor, "the full-screen editor needs a textarea");
  fireEvent.change(editor, { target: { value: "a very long prompt\nwith many lines" } });
  assert.equal(editor.value, "a very long prompt\nwith many lines");
  // Done closes the editor and the compact composer keeps the same text.
  // (The header ✕ shares the Done label; the footer button is the text one.)
  fireEvent.click(view.getByText("Done"));
  assert.equal(view.queryByRole("dialog"), null);
  const [compact] = view.container.querySelectorAll("textarea");
  assert.equal(compact.value, "a very long prompt\nwith many lines");
});

test("Ctrl+Enter in the full-screen editor sends the draft", async (t) => {
  const { view, sent } = await renderComposer(t);
  fireEvent.click(expandButton(view));
  const editor = view.getByRole("dialog").querySelector("textarea");
  fireEvent.change(editor, { target: { value: "send me" } });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.deepEqual(sent, ["send me"]);
  assert.equal(view.queryByRole("dialog"), null, "sending closes the editor");
});

test("Escape closes the full-screen editor without sending", async (t) => {
  const { view, sent } = await renderComposer(t);
  fireEvent.click(expandButton(view));
  const editor = view.getByRole("dialog").querySelector("textarea");
  fireEvent.change(editor, { target: { value: "keep me" } });
  fireEvent.keyDown(editor, { key: "Escape" });
  assert.equal(view.queryByRole("dialog"), null);
  assert.deepEqual(sent, []);
});
