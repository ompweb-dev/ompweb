import { execFile } from "child_process";
import { createChildProcessEnvironment } from "../project-command-env";

/**
 * The server's `gh` CLI: every GitHub call goes through a `GhRunner`, so the
 * data layer and tests can swap the process for a fake.
 */

export type GhRunner = (args: string[], input?: string) => Promise<string>;

export interface GhErrorDetails {
  stdout?: string;
  status?: number;
  responseHeaders?: Readonly<Record<string, string>>;
  responseBody?: { message?: string; documentationUrl?: string };
}

const refusalMessage = (fallback: string, details: GhErrorDetails): string => {
  const { status, responseHeaders: headers = {}, responseBody } = details;
  if (status !== 403 && status !== 429) return fallback;

  const reason = responseBody?.message?.trim().replace(/[\r\n]+/g, " ");
  const evidence: string[] = [];
  const sso = headers["x-github-sso"];
  const scopes = headers["x-oauth-scopes"];
  const acceptedScopes = headers["x-accepted-oauth-scopes"];
  const acceptedPermissions = headers["x-accepted-github-permissions"];
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const retryAfter = headers["retry-after"];

  if (sso) {
    evidence.push(`GitHub reports that SAML SSO authorization is required${sso.includes("url=") ? ` (${sso.slice(sso.indexOf("url=") + 4)})` : ""}.`);
  }
  if (remaining === "0") {
    evidence.push(`GitHub reports that the primary rate limit is exhausted${reset ? ` and resets at ${reset} UTC epoch seconds` : ""}.`);
  } else if (status === 429 || retryAfter || /secondary rate limit/i.test(reason ?? "")) {
    evidence.push(`GitHub reports rate limiting${retryAfter ? `; retry after ${retryAfter} seconds` : ""}.`);
  }
  if (scopes) evidence.push(`The login reports OAuth scopes: ${scopes}.`);
  if (acceptedScopes) {
    evidence.push(`The endpoint reports accepted OAuth scopes: ${acceptedScopes}; accepted scopes describe endpoint requirements and do not prove that a grant is missing.`);
  }
  if (acceptedPermissions) {
    evidence.push(
      `The endpoint reports accepted fine-grained permission sets: ${acceptedPermissions}; accepted permissions describe endpoint requirements and do not prove that the login lacks them.`,
    );
  }
  if (evidence.length === 0) evidence.push("GitHub did not report whether permissions, SSO, or rate limits caused this refusal.");
  return `GitHub refused the API request (HTTP ${status})${reason ? `: ${reason}.` : "."} ${evidence.join(" ")}`;
};

export class GhError extends Error {
  readonly stderr: string;
  readonly code: string | number | null | undefined;
  readonly stdout: string;
  readonly status: number | undefined;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseBody: GhErrorDetails["responseBody"];

  constructor(message: string, stderr: string, code: string | number | null | undefined, details: GhErrorDetails = {}) {
    const responseHeaders = allowlistedHeaders(details.responseHeaders);
    super(refusalMessage(message, { ...details, responseHeaders }));
    this.name = "GhError";
    this.stderr = stderr;
    this.code = code;
    this.stdout = details.stdout ?? "";
    this.status = details.status;
    this.responseHeaders = Object.freeze(responseHeaders);
    this.responseBody = details.responseBody && Object.freeze({ ...details.responseBody });
  }
}

export class GhUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhUnavailableError";
  }
}

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;

const RESPONSE_HEADERS: Record<string, true> = {
  "retry-after": true,
  "x-accepted-github-permissions": true,
  "x-accepted-oauth-scopes": true,
  "x-github-request-id": true,
  "x-github-sso": true,
  "x-oauth-scopes": true,
  "x-ratelimit-limit": true,
  "x-ratelimit-remaining": true,
  "x-ratelimit-reset": true,
  "x-ratelimit-resource": true,
  "x-ratelimit-used": true,
};

function allowlistedHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (RESPONSE_HEADERS[name]) allowed[name] = rawValue.replace(/[\r\n]+/g, " ");
  }
  return allowed;
}

function apiResponse(stdout: string): {
  stdout: string;
  status?: number;
  responseHeaders: Record<string, string>;
  responseBody?: GhErrorDetails["responseBody"];
} {
  const match = /^HTTP\/\S+\s+(\d{3})[^\r\n]*(?:\r?\n)/.exec(stdout);
  if (!match) return { stdout, responseHeaders: {} };
  const separator = stdout.indexOf("\r\n\r\n");
  const separatorLength = separator >= 0 ? 4 : 2;
  const headerEnd = separator >= 0 ? separator : stdout.indexOf("\n\n");
  if (headerEnd < 0) return { stdout, status: Number(match[1]), responseHeaders: {} };

  const responseHeaders: Record<string, string> = {};
  for (const line of stdout.slice(match[0].length, headerEnd).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (RESPONSE_HEADERS[name]) responseHeaders[name] = line.slice(colon + 1).trim();
  }
  const body = stdout.slice(headerEnd + separatorLength);
  let responseBody: GhErrorDetails["responseBody"];
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    responseBody = {
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
      ...(typeof parsed.documentation_url === "string" ? { documentationUrl: parsed.documentation_url } : {}),
    };
    if (Object.keys(responseBody).length === 0) responseBody = undefined;
  } catch {
    // Non-JSON API responses still remain available as stdout.
  }
  return { stdout: body, status: Number(match[1]), responseHeaders, responseBody };
}

export const defaultGhRunner: GhRunner = (args, input) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const api = args[0] === "api";
  const includeRequested = args.includes("--include") || args.includes("-i");
  const commandArgs = api ? ["api", "--hostname", "github.com", ...(includeRequested ? [] : ["--include"]), ...args.slice(1)] : args;
  const child = execFile(
    "gh",
    commandArgs,
    {
      // GH_PROMPT_DISABLED: a prompt would wait on a stdin that never answers.
      env: { ...createChildProcessEnvironment({ GH_PROMPT_DISABLED: "1" }), GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      encoding: "utf8",
    },
    (error, stdout, stderr) => {
      const response = api ? apiResponse(stdout) : { stdout, responseHeaders: {} };
      if (error) {
        const status = api ? (response.status ?? (Number(/\bHTTP(?:\/\S+)?\s+(\d{3})\b/i.exec(stderr)?.[1]) || undefined)) : undefined;
        reject(new GhError(stderr.trim() || error.message, stderr, error.code, { ...response, status }));
      } else {
        resolve(api ? response.stdout : stdout);
      }
    },
  );
  // A spawn failure (ENOENT) or an early exit can make the pipe error; the
  // callback above already reports the outcome.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input ?? "");
  return promise;
};

const NOT_INSTALLED =
  "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there.";
const NOT_LOGGED_IN = "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there.";
const AUTH_STDERR = /gh auth login|not logged (?:in|into)|HTTP 401|bad credentials/i;
const LOGIN_CACHE_MS = 60_000;

declare global {
  var __ompGhLogin: { run: GhRunner; login: string; at: number } | undefined;
}

/**
 * Proves `gh` is installed and logged in by asking GitHub who the account is.
 * A success is cached for 60 s, keyed to the runner that produced it, so a
 * fake runner in a test never sees another runner's answer.
 */
export async function checkGh(
  run: GhRunner = defaultGhRunner,
  now: () => number = Date.now,
): Promise<{ login: string }> {
  const cached = globalThis.__ompGhLogin;
  if (cached && cached.run === run && now() - cached.at < LOGIN_CACHE_MS) {
    return { login: cached.login };
  }
  let stdout: string;
  try {
    stdout = await run(["api", "user", "--jq", ".login"]);
  } catch (error) {
    if (error instanceof GhError && error.code === "ENOENT") throw new GhUnavailableError(NOT_INSTALLED);
    if (error instanceof GhError && (error.status === 401 || (error.status === undefined && AUTH_STDERR.test(error.stderr)))) {
      throw new GhUnavailableError(NOT_LOGGED_IN);
    }
    throw error;
  }
  const login = stdout.trim();
  globalThis.__ompGhLogin = { run, login, at: now() };
  return { login };
}

export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
  kind?: "workflow_run";
}

const TARGET_ERROR = 'Agent tool argument "target" must be OWNER/REPO#N or a GitHub pull request, issue or workflow run URL.';
// GitHub owners are alphanumeric with hyphens. Repos may start with dots,
// but "." and ".." are path segments, not repository names.
const OWNER = /^[A-Za-z0-9-]+$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const SHORT_FORM = /^([^/#\s]+)\/([^/#\s]+)#([1-9]\d{0,9})$/;

function validTarget(owner: string, repo: string, number: number): GithubTarget {
  if (!OWNER.test(owner) || !REPO.test(repo)) throw new Error(TARGET_ERROR);
  return { owner, repo, number };
}

/** GitHub item references; workflow runs always use their canonical URL as a key. */
export function parseGithubTarget(value: string): GithubTarget {
  const text = value.trim();
  const short = SHORT_FORM.exec(text);
  if (short) return validTarget(short[1], short[2], Number(short[3]));

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(TARGET_ERROR);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) throw new Error(TARGET_ERROR);
  const run = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  if (run) {
    const number = Number(run[3]);
    if (!Number.isSafeInteger(number)) throw new Error(TARGET_ERROR);
    return { ...validTarget(run[1], run[2], number), kind: "workflow_run" };
  }
  const path = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9]\d{0,9})(?:\/|$)/.exec(url.pathname);
  if (!path) throw new Error(TARGET_ERROR);
  return validTarget(path[1], path[2], Number(path[4]));
}

export function formatTarget(target: GithubTarget): string {
  if (target.kind === "workflow_run") return `https://github.com/${target.owner}/${target.repo}/actions/runs/${target.number}`;
  return `${target.owner}/${target.repo}#${target.number}`;
}
