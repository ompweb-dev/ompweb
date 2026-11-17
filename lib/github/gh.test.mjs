import assert from "node:assert/strict";
import test from "node:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spyOn } from "bun:test";
import * as projectCommandEnv from "../project-command-env.ts";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

const { GhError, GhUnavailableError, checkGh, defaultGhRunner, formatTarget, parseGithubTarget } = await import("./gh.ts");

const NOT_INSTALLED = "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there.";
const NOT_LOGGED_IN = "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there.";

test("checkGh maps a missing binary and a logged-out gh to the spec's messages", async () => {
  const missing = async () => {
    throw new GhError("spawn gh ENOENT", "", "ENOENT");
  };
  await assert.rejects(checkGh(missing, () => 0), (error) => {
    assert.ok(error instanceof GhUnavailableError);
    assert.equal(error.message, NOT_INSTALLED);
    return true;
  });

  const loggedOut = async () => {
    throw new GhError("gh api user failed", "To get started with GitHub CLI, please run:  gh auth login", 4);
  };
  await assert.rejects(checkGh(loggedOut, () => 0), (error) => {
    assert.ok(error instanceof GhUnavailableError);
    assert.equal(error.message, NOT_LOGGED_IN);
    return true;
  });

  const http401 = async () => {
    throw new GhError("gh api user failed", "HTTP 401: Bad credentials", 1);
  };
  await assert.rejects(checkGh(http401, () => 0), { message: NOT_LOGGED_IN });

  // Any other failure is not "gh unavailable"; the real error reaches the caller.
  const network = async () => {
    throw new GhError("gh api user failed", "dial tcp: i/o timeout", 1);
  };
  await assert.rejects(checkGh(network, () => 0), (error) => {
    assert.ok(error instanceof GhError);
    assert.ok(!(error instanceof GhUnavailableError));
    return true;
  });
});

test("checkGh caches a success for 60 s", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return "octocat\n";
  };
  assert.deepEqual(await checkGh(run, () => 1_000), { login: "octocat" });
  assert.deepEqual(calls, [["api", "user", "--jq", ".login"]]);

  assert.deepEqual(await checkGh(run, () => 60_999), { login: "octocat" });
  assert.equal(calls.length, 1);

  assert.deepEqual(await checkGh(run, () => 61_000), { login: "octocat" });
  assert.equal(calls.length, 2);
});

test("defaultGhRunner preserves API output while capturing safe refusal evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-gh-"));
  const executable = join(dir, "gh-fixture.cjs");
  writeFileSync(
    executable,
    `const endpoint = process.argv.find((value) => value.startsWith("fixture/"));
if (!process.argv.includes("--include")) process.exit(90);
const replies = {
  "fixture/json": [0, "HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{\\"ok\\":true}\\n", ""],
  "fixture/jq": [0, "HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\noctocat\\n", ""],
  "fixture/generic": [1, "HTTP/2.0 403 Forbidden\\r\\nx-github-request-id: SAFE-ID\\r\\nset-cookie: secret-cookie\\r\\n\\r\\n{\\"message\\":\\"Forbidden\\",\\"secret\\":\\"do-not-copy\\"}\\n", "gh: Forbidden (HTTP 403)\\n"],
};
const [code, stdout, stderr] = replies[endpoint];
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
`,
  );
  const realExecFile = childProcess.execFile;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await mockBuiltin(t, "node:child_process", {
    execFile: (_file, args, options, callback) => realExecFile(process.execPath, [executable, ...args], options, callback),
  });
  const { defaultGhRunner, GhError } = await import("./gh.ts?fresh=subprocess-fixture");

  assert.equal(await defaultGhRunner(["api", "fixture/json"]), '{"ok":true}\n');
  assert.equal(await defaultGhRunner(["api", "fixture/jq", "--jq", ".login"]), "octocat\n");
  assert.equal(await defaultGhRunner(["api", "fixture/json", "--include"]), '{"ok":true}\n');
  await assert.rejects(defaultGhRunner(["api", "fixture/generic"]), (error) => {
    assert.ok(error instanceof GhError);
    assert.equal(error.status, 403);
    assert.equal(error.stdout, '{"message":"Forbidden","secret":"do-not-copy"}\n');
    assert.deepEqual(error.responseHeaders, { "x-github-request-id": "SAFE-ID" });
    assert.deepEqual(error.responseBody, { message: "Forbidden" });
    assert.doesNotMatch(JSON.stringify(error.responseHeaders), /cookie|secret/i);
    assert.match(error.message, /GitHub refused the API request \(HTTP 403\): Forbidden/);
    assert.match(error.message, /did not report whether permissions, SSO, or rate limits caused/);
    return true;
  });
});

test("GitHub refusal diagnostics describe only observed permission and SSO evidence", async () => {
  const cases = [
    {
      headers: {
        "x-oauth-scopes": "repo, read:org",
        "x-accepted-oauth-scopes": "repo",
      },
      matches: [/login reports OAuth scopes: repo, read:org/i, /endpoint reports accepted OAuth scopes: repo/i],
    },
    {
      headers: { "x-accepted-github-permissions": "actions=write; contents=read,metadata=read" },
      matches: [/accepted fine-grained permission sets: actions=write; contents=read,metadata=read/i],
    },
    {
      headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=abc" },
      matches: [/GitHub reports that SAML SSO authorization is required/i, /https:\/\/github\.com\/orgs\/acme\/sso\?authorization_request=abc/],
    },
  ];
  for (const { headers, matches } of cases) {
    const error = new GhError("Forbidden", "gh: Forbidden (HTTP 403)", 1, {
      status: 403,
      responseHeaders: headers,
      responseBody: { message: "Resource not accessible by personal access token" },
    });
    for (const pattern of matches) assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /workflow scope/i);
  }
});

test("GitHub rate-limit diagnostics use observed reset evidence without retrying", () => {
  const primary = new GhError("rate limit exceeded", "", 1, {
    status: 403,
    responseHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794700800" },
    responseBody: { message: "API rate limit exceeded" },
  });
  assert.match(primary.message, /primary rate limit/i);
  assert.match(primary.message, /resets at 1794700800 UTC epoch seconds/i);

  const secondary = new GhError("secondary rate limit", "", 1, {
    status: 429,
    responseHeaders: { "retry-after": "60" },
    responseBody: { message: "You have exceeded a secondary rate limit" },
  });
  assert.match(secondary.message, /retry after 60 seconds/i);
});

test("checkGh keeps permission, SSO, rate-limit, and uncertain network failures intact", async () => {
  const failures = [
    new GhError("Forbidden", "gh: Forbidden (HTTP 403)", 1, { status: 403, responseHeaders: { "x-accepted-github-permissions": "metadata=read" } }),
    new GhError("SSO required", "gh: authentication requires SSO (HTTP 403)", 1, { status: 403, responseHeaders: { "x-github-sso": "required" } }),
    new GhError("rate limit", "gh: API rate limit exceeded (HTTP 403)", 1, { status: 403, responseHeaders: { "x-ratelimit-remaining": "0" } }),
    new GhError("dial tcp: i/o timeout", "dial tcp: i/o timeout", 1),
  ];
  for (const refusal of failures) {
    await assert.rejects(checkGh(async () => { throw refusal; }, () => 0), (error) => error === refusal);
  }
});

test("gh API requests use github.com and cannot inherit token credentials", async () => {
  let invocation;
  const environment = spyOn(projectCommandEnv, "createChildProcessEnvironment").mockReturnValue({
    GH_TOKEN: "inherited-token",
    GITHUB_TOKEN: "inherited-fallback-token",
    GH_HOST: "enterprise.example",
  });
  const spy = spyOn(childProcess, "execFile").mockImplementation((file, args, options, callback) => {
    invocation = { file, args, env: options.env };
    callback(null, "octocat\n", "");
    return { stdin: { on() {}, end() {} } };
  });
  try {
    await defaultGhRunner(["api", "user", "--jq", ".login"]);
    assert.equal(invocation.file, "gh");
    assert.deepEqual(invocation.args, ["api", "--hostname", "github.com", "--include", "user", "--jq", ".login"]);
    assert.equal(invocation.env.GH_TOKEN, undefined);
    assert.equal(invocation.env.GITHUB_TOKEN, undefined);
  } finally {
    spy.mockRestore();
    environment.mockRestore();
  }
});

test("Windows child lookups cannot inherit differently cased GitHub tokens", { skip: process.platform !== "win32" }, async () => {
  const realEnvironment = projectCommandEnv.createChildProcessEnvironment;
  const realExecFile = childProcess.execFile;
  const environment = spyOn(projectCommandEnv, "createChildProcessEnvironment").mockImplementation((...args) => {
    const values = realEnvironment(...args);
    for (const key of Object.keys(values)) {
      if (["GH_TOKEN", "GITHUB_TOKEN"].includes(key.toUpperCase())) delete values[key];
    }
    return { ...values, gh_token: "case-probe-token", github_token: "case-probe-fallback" };
  });
  const script = "[Console]::Write((ConvertTo-Json -InputObject @{ gh = [Environment]::GetEnvironmentVariable('GH_TOKEN'); github = [Environment]::GetEnvironmentVariable('GITHUB_TOKEN') } -Compress))";
  const executable = spyOn(childProcess, "execFile").mockImplementation((_file, _args, options, callback) =>
    realExecFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options, callback));
  try {
    const result = await defaultGhRunner(["api", "user"]);
    assert.deepEqual(JSON.parse(result), { gh: null, github: null });
  } finally {
    executable.mockRestore();
    environment.mockRestore();
  }
});

test("repository targets allow leading dots but reject dot path segments", () => {
  assert.deepEqual(parseGithubTarget("owner/.github#12"), { owner: "owner", repo: ".github", number: 12 });
  assert.deepEqual(parseGithubTarget("https://github.com/owner/.github-private/issues/12"), { owner: "owner", repo: ".github-private", number: 12 });
  assert.throws(() => parseGithubTarget("owner/.#12"));
  assert.throws(() => parseGithubTarget("owner/..#12"));
});

test("parseGithubTarget accepts both forms and refuses others", () => {
  const expected = { owner: "octo-cat", repo: "hello.world", number: 12 };
  assert.deepEqual(parseGithubTarget("octo-cat/hello.world#12"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/pull/12"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/issues/12"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/pull/12/files?w=1#diff-x"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/issues/12/"), expected);
  assert.equal(formatTarget(expected), "octo-cat/hello.world#12");

  const refused = [
    "owner/repo",
    "owner/repo#0",
    "owner/repo#12abc",
    "owner/repo#",
    "owner/../repo#1",
    "https://gitlab.com/owner/repo/pull/12",
    "https://github.com/owner/repo/commit/12",
    "https://github.com/owner/repo/pull/0",
    "http://github.com/owner/repo/pull/12",
    "",
  ];
  for (const value of refused) {
    assert.throws(
      () => parseGithubTarget(value),
      { message: 'Agent tool argument "target" must be OWNER/REPO#N or a GitHub pull request, issue or workflow run URL.' },
      value,
    );
  }
});

test("workflow run URLs retain safe large IDs and have isolated canonical keys", () => {
  const target = { owner: "acme", repo: "widgets", number: 123456789012, kind: "workflow_run" };
  for (const suffix of ["", "/", "/job/42?check=1#step:2"]) {
    assert.deepEqual(parseGithubTarget(`https://github.com/acme/widgets/actions/runs/123456789012${suffix}`), target);
  }
  assert.equal(formatTarget(target), "https://github.com/acme/widgets/actions/runs/123456789012");
  assert.notEqual(formatTarget({ ...target, kind: undefined }), formatTarget(target));
  assert.equal(parseGithubTarget("https://github.com/acme/widgets/actions/runs/9007199254740991").number, Number.MAX_SAFE_INTEGER);
  for (const url of [
    "https://github.com/acme/widgets/actions/runs/0",
    "https://github.com/acme/widgets/actions/runs/9007199254740992",
    "https://github.com/acme/widgets/actions/runs/12abc",
    "https://user:secret@github.com/acme/widgets/actions/runs/12",
    "https://github.com:8443/acme/widgets/actions/runs/12",
    "https://github.com/acme/widgets/pull/123456789012",
    "https://user@github.com/acme/widgets/issues/12",
    "https://github.com:8443/acme/widgets/pull/12",
  ]) assert.throws(() => parseGithubTarget(url), undefined, url);
});
