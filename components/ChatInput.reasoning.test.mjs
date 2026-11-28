import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { ChatInput } from "./ChatInput.tsx";

window.matchMedia = globalThis.matchMedia;

for (const [configuredThinkingLevel, observedThinkingLevel, label] of [
  ["auto", "low", "Auto (this turn: low)"],
  ["auto", undefined, "Auto"],
  ["low", "low", "Fixed: low"],
  [undefined, "low", "Level: low"],
  [undefined, undefined, "Thinking level"],
]) {
  test(`reasoning picker: ${label}`, (t) => {
    t.after(cleanup);
    const changes = [];
    const view = render(React.createElement(ChatInput, {
      onSend() {}, isStreaming: false, configuredThinkingLevel, observedThinkingLevel,
      onThinkingLevelChange: level => changes.push(level),
    }));
    const trigger = view.container.querySelector(".composer-thinking-control > button");
    if (!configuredThinkingLevel && !observedThinkingLevel) {
      assert.ok(trigger.querySelector('.composer-thinking-glyph[aria-hidden="true"] svg'), "compact picker needs a neutral glyph");
    }
    assert.equal(trigger.textContent, label);
    assert.ok(trigger.getAttribute("aria-label").endsWith(label));
    fireEvent.click(trigger);
    assert.deepEqual(view.queryAllByRole("menuitemradio", { checked: true }).map(row => row.textContent),
      configuredThinkingLevel ? [configuredThinkingLevel === "auto" ? "Auto" : configuredThinkingLevel] : []);
    fireEvent.click(view.getByRole("menuitemradio", { name: "low" }));
    assert.deepEqual(changes, configuredThinkingLevel === "low" ? [] : ["low"]);
  });
}

for (const locked of ["thinkingLevelDisabled", "isStreaming"]) {
  test(`reasoning picker cannot submit while ${locked}`, (t) => {
    t.after(cleanup);
    const view = render(React.createElement(ChatInput, { onSend() {}, onThinkingLevelChange() {}, [locked]: true }));
    assert.equal(view.container.querySelector(".composer-thinking-control > button").disabled, true);
  });
}

for (const [mode, observed, useDraftThinkingDefault, label, selected] of [
  ["medium", "low", false, "Fixed: medium", "medium → low"],
  ["auto", "low", false, "Auto (this turn: low)", "Auto"],
  [undefined, "low", false, "Level: low", undefined],
  ["auto", undefined, true, "Use omp default", "Use omp default"],
]) {
  test(`model mapping and draft semantics: ${label}`, (t) => {
    t.after(cleanup);
    const view = render(React.createElement(ChatInput, {
      onSend() {}, onThinkingLevelChange() {}, configuredThinkingLevel: mode, observedThinkingLevel: observed,
      useDraftThinkingDefault, thinkingLevelMap: { medium: "low", low: "minimal" },
    }));
    const trigger = view.container.querySelector(".composer-thinking-control > button");
    assert.equal(trigger.textContent, label);
    fireEvent.click(trigger);
    assert.deepEqual(view.queryAllByRole("menuitemradio", { checked: true }).map(row => row.textContent), selected ? [selected] : []);
  });
}
