import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mock } from "bun:test";

const agentCommands = [];
mock.module("@/lib/agent-client", () => ({
  sendAgentCommand: (_sessionId, command) => {
    agentCommands.push(command);
    return new Promise(() => {});
  },
}));
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react/pure.js");
const { TaskBlock, CompletionBlock, SubagentDetails, SubagentTranscriptDialog } = await import("./SubagentTranscriptDialog.tsx");

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  agentCommands.length = 0;
});

test("shows the provider-qualified model and reasoning effort split from the resolved model", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentDetails, {
    resolvedModel: "anthropic/claude-sonnet-5-5:high",
  }));
  assert.match(html, /<dt[^>]*>model<\/dt><dd[^>]*>anthropic\/claude-sonnet-5-5<\/dd>/);
  assert.match(html, /<dt[^>]*>effort<\/dt><dd[^>]*>high<\/dd>/);
});

test("labels the agent and the full session file on rows of their own", () => {
  const file = "/root/git/ai-harness-settings/ai-dev/omp/agent/sessions/long/0-Task.jsonl";
  const html = renderToStaticMarkup(React.createElement(SubagentDetails, { agent: "task", resolvedModel: "p/m:medium", file }));
  assert.match(html, /<dt[^>]*>agent<\/dt><dd[^>]*>task<\/dd>/);
  assert.match(html, new RegExp(`<dt[^>]*>file</dt><dd[^>]*>${file}</dd>`));
  assert.doesNotMatch(html, /ellipsis|nowrap/);
});

test("renders nothing when no resolved model is known", () => {
  assert.equal(renderToStaticMarkup(React.createElement(SubagentDetails, {})), "");
});

test("splits the max effort level and keeps a non-effort suffix in the model id", () => {
  const max = renderToStaticMarkup(React.createElement(SubagentDetails, { resolvedModel: "m:max" }));
  assert.match(max, /<dt[^>]*>model<\/dt><dd[^>]*>m<\/dd>/);
  assert.match(max, /<dt[^>]*>effort<\/dt><dd[^>]*>max<\/dd>/);
  const tagged = renderToStaticMarkup(React.createElement(SubagentDetails, { resolvedModel: "p/m:free" }));
  assert.match(tagged, /<dt[^>]*>model<\/dt><dd[^>]*>p\/m:free<\/dd>/);
  assert.doesNotMatch(tagged, />effort</);
});

test("renders the task as markdown with its label", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, {
    task: "# Target\nReview the changes.",
  }));
  assert.match(html, /Task/);
  assert.match(html, /Target/);
  assert.match(html, /Review the changes\./);
});

test("renders nothing for an empty task", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, { task: "" }));
  assert.equal(html, "");
});

test("renders plain-text completion with its label", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "Everything passes.",
    truncated: false,
  }));
  assert.match(html, /Result/);
  assert.match(html, /Everything passes\./);
  assert.doesNotMatch(html, /Output truncated/);
});

test("renders structured JSON completions as key/value rows", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"overall_correctness":"incorrect","explanation":"x"}',
    truncated: false,
  }));
  assert.match(html, /overall_correctness/);
  assert.match(html, />incorrect</);
  assert.match(html, /explanation/);
  assert.match(html, />x</);
});

test("renders single-value JSON completions with unescaped line breaks", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"report":"Line one\\nLine two"}',
    truncated: false,
  }));
  assert.match(html, /Line one\nLine two/);
  assert.doesNotMatch(html, /\\n/);
});

test("shows the truncation note when the output was capped", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "partial",
    truncated: true,
  }));
  assert.match(html, /Output truncated/);
});

test("shows an empty state when no completion exists yet", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: null,
    truncated: false,
  }));
  assert.match(html, /No output yet/);
});

test("loads a live subagent transcript from disk without waiting for its agent command", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requests.push(href);
    if (href.includes("mode=completion")) {
      return Response.json({ completion: "Finished.", truncated: false });
    }
    return Response.json({
      sessionFile: "/sessions/StrictRunnerD2Luna.jsonl",
      fromByte: 0,
      nextByte: 42,
      totalBytes: 42,
      messages: [{ role: "user", content: "First transcript message" }],
    });
  };

  const view = render(React.createElement(SubagentTranscriptDialog, {
    subagent: { id: "StrictRunnerD2Luna", source: "live" },
    sessionId: "session-1",
    transcriptVersion: 0,
    onClose() {},
  }));
  await waitFor(() => assert.match(document.body.textContent, /Finished\./));
  fireEvent.click(view.getByRole("button", { name: "Show transcript" }));

  await waitFor(() => assert.ok(requests.some((href) => href.includes("fromByte=0"))));
  assert.match(document.body.textContent, /First transcript message/);
  assert.equal(agentCommands.some((command) => command.type === "get_subagent_messages"), false);
});

test("shows an artifact reader error instead of an empty transcript", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("mode=completion")) {
      return Response.json({ completion: "Finished.", truncated: false });
    }
    return Response.json({
      sessionFile: "/sessions/StrictRunnerD2Luna.jsonl",
      fromByte: 0,
      nextByte: 0,
      messages: [],
      error: "Subagent transcript exceeds the readable size limit",
    });
  };

  const view = render(React.createElement(SubagentTranscriptDialog, {
    subagent: { id: "StrictRunnerD2Luna", source: "live" },
    sessionId: "session-1",
    transcriptVersion: 0,
    onClose() {},
  }));
  await waitFor(() => assert.match(document.body.textContent, /Finished\./));
  fireEvent.click(view.getByRole("button", { name: "Show transcript" }));

  await waitFor(() => assert.match(document.body.textContent, /Subagent transcript exceeds the readable size limit/));
});

test("shows the error body from an unsuccessful transcript response", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("mode=completion")) {
      return Response.json({ completion: "Finished.", truncated: false });
    }
    return Response.json({ error: "Transcript storage is unavailable" }, { status: 500 });
  };

  const view = render(React.createElement(SubagentTranscriptDialog, {
    subagent: { id: "StrictRunnerD2Luna", source: "live" },
    sessionId: "session-1",
    transcriptVersion: 0,
    onClose() {},
  }));
  await waitFor(() => assert.match(document.body.textContent, /Finished\./));
  fireEvent.click(view.getByRole("button", { name: "Show transcript" }));

  await waitFor(() => assert.match(document.body.textContent, /Transcript storage is unavailable/));
});

test("refreshes an open transcript while completion metadata is stalled", async () => {
  let pageRequests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("mode=completion")) return new Response(null, { status: 404 });
    pageRequests += 1;
    return Response.json({
      sessionFile: "/sessions/StrictRunnerD2Luna.jsonl",
      fromByte: pageRequests === 1 ? 0 : 42,
      nextByte: 42,
      totalBytes: 42,
      messages: pageRequests === 1 ? [{ role: "user", content: "First transcript message" }] : [],
    });
  };
  const props = (transcriptVersion) => ({
    subagent: { id: "StrictRunnerD2Luna", source: "live" },
    sessionId: "session-1",
    transcriptVersion,
    onClose() {},
  });

  const view = render(React.createElement(SubagentTranscriptDialog, props(0)));
  fireEvent.click(await view.findByRole("button", { name: "Show transcript" }));
  await waitFor(() => assert.equal(pageRequests, 1));

  view.rerender(React.createElement(SubagentTranscriptDialog, props(1)));
  await waitFor(() => assert.equal(pageRequests, 2), { timeout: 2_000 });
});
