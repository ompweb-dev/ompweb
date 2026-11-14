import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AppUpdateApiError,
  commitAppUpdate,
  fetchAppUpdateJson,
  isAwaitingAppUpdateApproval,
  isStaleAppUpdatePlanError,
  prepareAppUpdate,
} from "./AppShell-app-update";

const plan = { id: "plan-1", hosts: [], requiresForce: false };

/** Replace fetch for one test and record the requests it saw. */
function stubFetch(t, respond) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    return respond(requests.length - 1);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return requests;
}

test("preparing an update sends only a prepare request and never commits", async (t) => {
  const requests = stubFetch(t, () => Response.json({ attemptId: "attempt-1", targetVersion: "0.8.0", plan }, { status: 202 }));
  const prepared = await prepareAppUpdate();
  assert.deepEqual(prepared, { attemptId: "attempt-1", targetVersion: "0.8.0", plan });
  assert.deepEqual(requests, [{ url: "/api/app-update", method: "POST", body: { action: "prepare" } }]);
});

test("a prepare response without a plan is rejected rather than committed blind", async (t) => {
  stubFetch(t, () => Response.json({ attemptId: "attempt-1", targetVersion: "0.8.0" }, { status: 202 }));
  await assert.rejects(prepareAppUpdate(), /Invalid update response/);
});

test("a commit carries exactly the approval the user gave, naming the plan", async (t) => {
  const requests = stubFetch(t, () => Response.json({ accepted: true, attemptId: "attempt-1" }, { status: 202 }));
  await commitAppUpdate("attempt-1", { planId: "plan-1", force: true });
  assert.deepEqual(requests, [{
    url: "/api/app-update", method: "POST",
    body: { action: "commit", attemptId: "attempt-1", approval: { planId: "plan-1", force: true } },
  }]);
});

test("a refused commit surfaces its HTTP status so a changed plan is re-reviewed", async (t) => {
  stubFetch(t, () => Response.json({ error: "The upgrade plan no longer matches the connected hosts" }, { status: 409 }));
  const error = await commitAppUpdate("attempt-1", { planId: "plan-1", force: false }).catch((cause) => cause);
  assert.ok(error instanceof AppUpdateApiError);
  assert.equal(error.status, 409);
  assert.equal(isStaleAppUpdatePlanError(error), true);
});

test("only plan-mismatch statuses trigger a re-prepare; other failures stay failures", async (t) => {
  stubFetch(t, (index) => index === 0
    ? Response.json({ error: "Disk full" }, { status: 500 })
    : new Response("{}", { status: 503 }));
  const server = await fetchAppUpdateJson("/api/app-update").catch((cause) => cause);
  assert.equal(isStaleAppUpdatePlanError(server), false);
  const unavailable = await fetchAppUpdateJson("/api/app-update").catch((cause) => cause);
  assert.equal(unavailable.status, 503);
  assert.equal(isStaleAppUpdatePlanError(unavailable), false);
  assert.equal(isStaleAppUpdatePlanError(new Error("HTTP 409")), false);
});

test("a prepared attempt without a recorded approval is only a proposal", () => {
  const status = { attemptId: "attempt-1", state: "prepared", fromVersion: "0.7.0", targetVersion: "0.8.0", preparedAt: "now", stage: "preparing" };
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: status, upgradePlan: plan }), true);
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: status }), true);
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: status, upgradePlan: { ...plan, approved: { force: false, at: "now" } } }), true);
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: { ...status, state: "running" } }), false);
  assert.equal(isAwaitingAppUpdateApproval(null), false);
});

test("closing and reopening a stalled update keeps its admission lock until terminal reconciliation", async () => {
  const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // Exercise the shell's callbacks without mounting its unrelated session and editor providers.
  const callback = (name, scope) => {
    const body = new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[`).exec(source)?.[1];
    assert.ok(body, `${name} callback exists`);
    return new Function(...Object.keys(scope), body).bind(null, ...Object.values(scope));
  };
  const stalled = { attemptId: "attempt-1", targetVersion: "0.8.0" };
  const scope = {
    appUpdatePhase: "stalled",
    appUpdate: { availableVersion: "0.8.0" },
    appUpdateStalledRef: { current: stalled },
    appUpdateAttemptRef: { current: stalled.attemptId },
    appUpdateStartInFlightRef: { current: true },
    setAppUpdateDialogOpen: (value) => { open = value; },
    setAppUpdatePhase: (value) => { phase = value; },
    setAppUpdateError: () => assert.fail("a stalled attempt must not be discarded"),
    discardAppUpdatePlan: () => assert.fail("a stalled attempt must not be discarded"),
    resetAppUpdateVisibleStage: () => assert.fail("a stalled attempt must not be discarded"),
    setSettingsTab: () => {},
    monitorAppUpdate: (attemptId, targetVersion) => { monitored = { attemptId, targetVersion }; },
    window: { requestAnimationFrame: (run) => run() },
  };
  let open = true;
  let phase = "stalled";
  let monitored;
  callback("dismissAppUpdate", scope)();
  assert.equal(open, false);
  assert.equal(phase, "stalled");
  assert.equal(scope.appUpdateStalledRef.current, stalled);
  assert.equal(scope.appUpdateAttemptRef.current, stalled.attemptId);
  assert.equal(scope.appUpdateStartInFlightRef.current, true);

  scope.checkStalledAppUpdate = callback("checkStalledAppUpdate", scope);
  callback("requestAppUpdateFromSettings", scope)();
  assert.equal(open, true);
  assert.equal(phase, "restarting");
  assert.deepEqual(monitored, stalled);
  assert.equal(scope.appUpdateStalledRef.current, null);
  assert.equal(scope.appUpdateStartInFlightRef.current, true, "only terminal reconciliation releases admission");

  scope.setAppUpdateError = () => {};
  scope.appUpdateCommittedAttemptRef = { current: stalled.attemptId };
  scope.appUpdateStageFlowRef = { current: 0 };
  scope.sanitizeAppUpdateError = (error) => error;
  const failureBody = /const showAppUpdateFailure = useCallback\(\(error: unknown\) => \{([\s\S]*?)\n  \}, \[/.exec(source)?.[1];
  assert.ok(failureBody);
  scope.showAppUpdateFailure = new Function(...Object.keys(scope), "error", failureBody).bind(null, ...Object.values(scope));
  scope.acknowledgeAppUpdate = async (attemptId) => {
    assert.equal(attemptId, stalled.attemptId);
    return true;
  };
  const terminalBody = /const handleTerminalAppUpdate = useCallback\(async \([\s\S]*?\): Promise<boolean> => \{([\s\S]*?)\n  \}, \[/.exec(source)?.[1];
  assert.ok(terminalBody);
  const terminal = new Function(...Object.keys(scope), "data", "attemptId", "targetVersion", `return (async () => {${terminalBody}})();`).bind(null, ...Object.values(scope));
  assert.equal(await terminal({ selfUpdateStatus: { attemptId: stalled.attemptId, state: "failed", cleanupReady: true, error: "Update recovered" } }, stalled.attemptId, stalled.targetVersion), true);
  assert.equal(scope.appUpdateAttemptRef.current, null);
  assert.equal(scope.appUpdateStartInFlightRef.current, false);
  assert.equal(phase, "failed", "a new plan is only available after the old attempt is reconciled");
});
