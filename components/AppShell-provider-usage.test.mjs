import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { useProviderUsage } = await import("./AppShell-provider-usage.ts");

const snapshot = (percent) => ({ reports: [{ provider: "provider", fiveHour: { percent } }] });

test("manual refresh gets fresh limits on older browsers while automatic polling stays silent", async () => {
  const originalFetch = globalThis.fetch;
  const originalInterval = window.setInterval;
  const originalClear = window.clearInterval;
  const sizeDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
  let poll;
  let finishPoll;
  let freshPercent = 10;
  let cachedPercent = 10;
  let unavailable = false;
  try {
    delete URLSearchParams.prototype.size;
    window.setInterval = (callback) => { poll = callback; return 1; };
    window.clearInterval = () => {};
    globalThis.fetch = async (url) => {
      if (new URL(url, "http://localhost").searchParams.get("refresh") === "true") cachedPercent = freshPercent;
      const response = unavailable ? new Response(null, { status: 502 }) : Response.json(snapshot(cachedPercent));
      if (finishPoll) await new Promise((resolve) => { finishPoll.resolve = resolve; });
      return response;
    };
    const { result, unmount } = renderHook(() => useProviderUsage("", 300_000));
    await act(async () => {});
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 10);
    freshPercent = 80;
    finishPoll = {};
    act(() => poll());
    assert.equal(result.current.loading, false, "background polling must not change the loading state");
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 10);
    await act(async () => { finishPoll.resolve(); });
    finishPoll = undefined;
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 10, "automatic polling must not force cache invalidation");
    let refreshed;
    await act(async () => { refreshed = await result.current.refresh(); });
    assert.equal(refreshed, true);
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 80, "manual refresh must request fresh limits even without URLSearchParams.size");
    freshPercent = 95;
    finishPoll = {};
    act(() => poll());
    let queuedRefresh;
    act(() => { queuedRefresh = result.current.refresh(); });
    await act(async () => {
      const resolve = finishPoll.resolve;
      finishPoll = undefined;
      resolve();
      assert.equal(await queuedRefresh, true);
    });
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 95, "manual refresh during a background poll must still fetch fresh limits");
    // A reload() after a mutation must not settle on a pre-update GET that is still in flight.
    cachedPercent = 40;
    finishPoll = {};
    act(() => poll());
    cachedPercent = 65;
    let reloaded;
    act(() => { reloaded = result.current.reload(); });
    await act(async () => {
      const resolve = finishPoll.resolve;
      finishPoll = undefined;
      resolve();
      assert.equal(await reloaded, true);
    });
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 65, "reload during an in-flight GET must issue a post-mutation non-forced GET");
    unavailable = true;
    await act(async () => { assert.equal(await result.current.reload(), false); });
    assert.equal(result.current.error, true);
    assert.equal(result.current.snapshot.reports[0].fiveHour.percent, 65, "a failed refresh retains the last visible snapshot");

    unavailable = false;
    finishPoll = {};
    act(() => poll());
    unavailable = true;
    let afterLogout;
    act(() => { afterLogout = result.current.reload({ invalidate: true }); });
    await act(async () => {
      const finish = finishPoll.resolve;
      finishPoll = undefined;
      finish();
      assert.equal(await afterLogout, false);
    });
    assert.equal(result.current.error, true);
    assert.equal(result.current.snapshot, null, "a pre-logout poll cannot bring back invalidated rows");
    unavailable = false;
    finishPoll = {};
    let cancelled;
    act(() => { cancelled = result.current.refresh(); });
    unmount();
    await act(async () => { finishPoll.resolve(); });
    assert.equal(await cancelled, false, "an unmounted refresh cannot report success");
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    window.setInterval = originalInterval;
    window.clearInterval = originalClear;
    if (sizeDescriptor) Object.defineProperty(URLSearchParams.prototype, "size", sizeDescriptor);
  }
});
