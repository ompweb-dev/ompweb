import assert from "node:assert/strict";
import test from "node:test";

const { parseGithubRemoteUrl, pickGithubRepo, resolveGithubRepo } = await import("./github-repo.ts");

test("parses GitHub remote URL forms and rejects other hosts", () => {
  for (const url of [
    "https://github.com/o-1/r.x",
    "https://github.com/o-1/r.x.git",
    "https://token@github.com/o-1/r.x/",
    "git@github.com:o-1/r.x.git",
    "ssh://git@github.com/o-1/r.x.git",
  ]) {
    assert.equal(parseGithubRemoteUrl(url), "o-1/r.x", url);
  }
  assert.equal(parseGithubRemoteUrl("https://gitlab.com/o/r.git"), null);
  assert.equal(parseGithubRemoteUrl("https://github.com.evil.test/o/r"), null);
});

test("prefers the gh default remote, then upstream over origin", () => {
  const remotes = [
    "remote.origin.url git@github.com:fork/app.git",
    "remote.upstream.url https://github.com/main/app.git",
  ];
  assert.equal(pickGithubRepo(remotes.join("\n")), "main/app");
  assert.equal(pickGithubRepo([...remotes, "remote.origin.gh-resolved base"].join("\n")), "fork/app");
  assert.equal(pickGithubRepo([...remotes, "remote.origin.gh-resolved other/app"].join("\n")), "other/app");
  // A gh default on a non-GitHub remote is ignored in favour of the GitHub remotes.
  assert.equal(pickGithubRepo("remote.corp.url https://gitlab.com/x/y\nremote.corp.gh-resolved stale/y\nremote.origin.url git@github.com:me/y"), "me/y");
});

test("skips non-GitHub remotes and returns null when none match", () => {
  assert.equal(pickGithubRepo("remote.upstream.url https://gitlab.com/x/y\nremote.mine.url git@github.com:me/y"), "me/y");
  assert.equal(pickGithubRepo("remote.origin.url /srv/repo.git"), null);
  assert.equal(pickGithubRepo(""), null);
});

test("expands insteadOf shorthands from a real checkout's git config", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "github-repo-"));
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  const execute = promisify(execFile);
  try {
    // The fixture and resolver must see the same private config, not the runner's Git settings.
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_TERMINAL_PROMPT = "0";
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
    const git = async (...args) => {
      try {
        const { stdout } = await execute("git", ["-C", dir, ...args], { timeout: 5_000, encoding: "utf8" });
        return stdout;
      } catch (error) {
        throw new Error(`Git fixture phase ${args.join(" ")} failed: ${error.message}`, { cause: error });
      }
    };
    await git("init", "-q");
    await git("config", "url.git@github.com:.insteadOf", "gh:");
    await git("config", "url.git@github.com:other/.insteadOf", "gh:long/");
    await git("remote", "add", "origin", "gh:long/app.git");
    // Longest prefix wins, matching git's own expansion.
    assert.match(await git("remote", "get-url", "origin"), /github\.com:other\/app\.git/);
    assert.equal(await resolveGithubRepo(dir), "other/app");
    await git("remote", "set-url", "origin", "gh:me/app.git");
    assert.equal(await resolveGithubRepo(dir), "me/app");
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
