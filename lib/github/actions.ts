import { parse as parseYaml } from "yaml";
import { GhError, type GhRunner, type GithubTarget } from "./gh";
import { isRecord } from "../type-guards";

const API_VERSION = ["-H", "X-GitHub-Api-Version: 2022-11-28"];
const UNKNOWN_WRITE_OUTCOME = "The GitHub Actions write outcome is unknown; inspect the workflow or run before retrying.";
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_FILE = /^(?!\.{1,2}$)[^/\\\0]{1,255}\.(?:yml|yaml)$/i;
const MAX_INPUT_JSON_BYTES = 65_535;
const MAX_WORKFLOW_BYTES = 1024 * 1024;

function repository(value: string): { owner: string; repo: string; path: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || !OWNER.test(parts[0]) || !REPO.test(parts[1])) {
    throw new Error("repo must use strict OWNER/REPO syntax.");
  }
  return { owner: parts[0], repo: parts[1], path: `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}` };
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function workflowId(value: string): string {
  if (/^[1-9]\d*$/.test(value)) {
    positiveInteger(Number(value), "workflow");
    return value;
  }
  if (!WORKFLOW_FILE.test(value)) throw new Error("workflow must be a positive id or a .yml/.yaml basename.");
  return value;
}

function bounded(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value) > max || /\0/.test(value)) {
    throw new Error(`${name} must be a nonempty string of at most ${max} bytes.`);
  }
  return value;
}

async function getRecord(run: GhRunner, path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await run(["api", path]));
  if (!isRecord(value)) throw new Error("GitHub returned a malformed object response.");
  return value;
}

function pageResult(value: Record<string, unknown>, key: string, page: number): Record<string, unknown> {
  const totalCount = value.total_count;
  if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0 || !Array.isArray(value[key])) {
    throw new Error("GitHub returned malformed pagination data.");
  }
  const totalPages = Math.ceil(totalCount / 100);
  return {
    ...value,
    pagination: { page, perPage: 100, totalCount, totalPages, hasNextPage: page < totalPages },
  };
}

export async function listWorkflows(run: GhRunner, repo: string, page = 1): Promise<Record<string, unknown>> {
  const target = repository(repo);
  positiveInteger(page, "page");
  const response = await getRecord(run, `repos/${target.path}/actions/workflows?per_page=100&page=${page}`);
  return pageResult(response, "workflows", page);
}

interface RunFilters {
  workflow?: string;
  branch?: string;
  headSha?: string;
  event?: string;
  status?: string;
  page?: number;
}

export async function listRuns(run: GhRunner, repo: string, filters: RunFilters): Promise<Record<string, unknown>> {
  const target = repository(repo);
  const page = filters.page ?? 1;
  positiveInteger(page, "page");
  const base = filters.workflow === undefined
    ? `repos/${target.path}/actions/runs`
    : `repos/${target.path}/actions/workflows/${encodeURIComponent(workflowId(filters.workflow))}/runs`;
  const query = new URLSearchParams();
  if (filters.branch !== undefined) query.set("branch", bounded(filters.branch, "branch"));
  if (filters.headSha !== undefined) query.set("head_sha", bounded(filters.headSha, "headSha"));
  if (filters.event !== undefined) query.set("event", bounded(filters.event, "event", 100));
  if (filters.status !== undefined) query.set("status", bounded(filters.status, "status", 100));
  query.set("per_page", "100");
  query.set("page", String(page));
  return pageResult(await getRecord(run, `${base}?${query}`), "workflow_runs", page);
}

type DispatchInput = { type: string; required: boolean; default?: string | number | boolean | null; options?: (string | number | boolean | null)[] };

function dispatchDefinition(document: unknown): { supported: boolean; inputs: Record<string, DispatchInput> } {
  if (!isRecord(document)) return { supported: false, inputs: {} };
  const events = document.on;
  let definition: unknown;
  let supported = false;
  if (events === "workflow_dispatch") supported = true;
  else if (Array.isArray(events)) supported = events.includes("workflow_dispatch");
  else if (isRecord(events) && Object.hasOwn(events, "workflow_dispatch")) {
    supported = true;
    definition = events.workflow_dispatch;
  }
  if (!supported) return { supported: false, inputs: {} };
  if (definition == null) return { supported: true, inputs: {} };
  if (!isRecord(definition)) throw new Error("workflow_dispatch must be a mapping.");
  if (definition.inputs === undefined) return { supported: true, inputs: {} };
  if (!isRecord(definition.inputs)) throw new Error("workflow_dispatch inputs must be a mapping.");

  const inputs: Record<string, DispatchInput> = {};
  for (const [name, value] of Object.entries(definition.inputs)) {
    if (!isRecord(value)) throw new Error(`workflow_dispatch input ${name} must be a mapping.`);
    const type = value.type === undefined ? "string" : value.type;
    if (typeof type !== "string" || !type) throw new Error(`workflow_dispatch input ${name} has an invalid type.`);
    if (value.required !== undefined && typeof value.required !== "boolean") {
      throw new Error(`workflow_dispatch input ${name} has an invalid required flag.`);
    }
    const input: DispatchInput = { type, required: value.required === true };
    if (Object.hasOwn(value, "default")) {
      if (value.default !== null && (!["string", "number", "boolean"].includes(typeof value.default) || (typeof value.default === "number" && !Number.isFinite(value.default)))) {
        throw new Error(`workflow_dispatch input ${name} has an invalid default.`);
      }
      input.default = value.default as string | number | boolean | null;
    }
    if (Object.hasOwn(value, "options")) {
      if (!Array.isArray(value.options) || value.options.some((option) => option !== null && (!["string", "number", "boolean"].includes(typeof option) || (typeof option === "number" && !Number.isFinite(option))))) {
        throw new Error(`workflow_dispatch input ${name} has invalid options.`);
      }
      input.options = value.options as (string | number | boolean | null)[];
    }
    inputs[name] = input;
  }
  return { supported: true, inputs };
}

function decodeWorkflow(value: Record<string, unknown>): unknown {
  if (value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new Error("GitHub returned malformed workflow contents.");
  }
  const encoded = value.content.replace(/\s/g, "");
  if (encoded.length > Math.ceil(MAX_WORKFLOW_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("GitHub returned invalid or oversized workflow contents.");
  }
  const source = Buffer.from(encoded, "base64");
  if (source.byteLength > MAX_WORKFLOW_BYTES) throw new Error("GitHub returned oversized workflow contents.");
  return parseYaml(source.toString("utf8"));
}

export async function readWorkflow(run: GhRunner, repo: string, workflow: string, ref: string): Promise<Record<string, unknown>> {
  const target = repository(repo);
  const id = workflowId(workflow);
  bounded(ref, "ref");
  const metadata = await getRecord(run, `repos/${target.path}/actions/workflows/${encodeURIComponent(id)}`);
  if (
    typeof metadata.id !== "number" || !Number.isSafeInteger(metadata.id) || metadata.id <= 0 ||
    typeof metadata.path !== "string" || !/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(metadata.path) ||
    typeof metadata.state !== "string"
  ) {
    throw new Error("GitHub returned malformed workflow metadata.");
  }
  const path = metadata.path.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({ ref });
  const contents = await getRecord(run, `repos/${target.path}/contents/${path}?${query}`);
  const dispatch = dispatchDefinition(decodeWorkflow(contents));
  const enabled = metadata.state === "active";
  return {
    workflow: metadata,
    workflowDispatch: {
      supported: dispatch.supported,
      enabled,
      ...(!dispatch.supported ? { reason: "missing_trigger" } : !enabled ? { reason: "workflow_disabled" } : {}),
      inputs: dispatch.inputs,
    },
  };
}

function checkedInputs(inputs: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  if (!isRecord(inputs)) throw new Error("inputs must be an object.");
  const prototype = Object.getPrototypeOf(inputs);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("inputs must be an object.");
  const entries = Object.entries(inputs);
  if (entries.length > 25) throw new Error("inputs may contain at most 25 keys.");
  for (const [key, value] of entries) {
    if (!key || Buffer.byteLength(key) > 100 || !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error("inputs must contain bounded keys and string, finite number, or boolean values.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(inputs)) > MAX_INPUT_JSON_BYTES) throw new Error("inputs JSON is too large.");
  return inputs;
}

function githubStatus(error: GhError): number | undefined {
  const reported = (error as GhError & { httpStatus?: unknown; status?: unknown }).httpStatus
    ?? (error as GhError & { status?: unknown }).status;
  if (typeof reported === "number") return reported;
  const match = /\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i.exec(`${error.stderr}\n${error.message}`);
  return match ? Number(match[1]) : undefined;
}

function uncertainWrite(error: unknown): Error {
  const status = error instanceof GhError ? githubStatus(error) : undefined;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) return error as GhError;
  return new Error(UNKNOWN_WRITE_OUTCOME, { cause: error });
}

async function mutate(run: GhRunner, args: string[], input?: string): Promise<string> {
  try {
    return await run(args, input);
  } catch (error) {
    throw uncertainWrite(error);
  }
}

export async function dispatchWorkflow(
  run: GhRunner,
  repo: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string | number | boolean>,
): Promise<{ runId: number; url: string }> {
  const target = repository(repo);
  const id = workflowId(workflow);
  bounded(ref, "ref");
  const body = JSON.stringify({ ref, inputs: checkedInputs(inputs), return_run_details: true });
  let response: unknown;
  try {
    const output = await mutate(run, [
      "api", "-X", "POST", `repos/${target.path}/actions/workflows/${encodeURIComponent(id)}/dispatches`,
      ...API_VERSION, "--input", "-",
    ], body);
    response = JSON.parse(output);
  } catch (error) {
    if (error instanceof GhError || (error instanceof Error && error.message === UNKNOWN_WRITE_OUTCOME)) throw error;
    throw new Error(UNKNOWN_WRITE_OUTCOME, { cause: error });
  }
  if (!isRecord(response) || typeof response.workflow_run_id !== "number" || !Number.isSafeInteger(response.workflow_run_id) || response.workflow_run_id <= 0) {
    throw new Error(UNKNOWN_WRITE_OUTCOME);
  }
  const runId = response.workflow_run_id;
  return { runId, url: `https://github.com/${target.owner}/${target.repo}/actions/runs/${runId}` };
}

function runTarget(target: GithubTarget): { owner: string; repo: string; path: string; number: number } {
  if (target.kind !== "workflow_run") throw new Error("target must be a GitHub workflow run URL.");
  const repo = repository(`${target.owner}/${target.repo}`);
  return { ...repo, number: positiveInteger(target.number, "run id") };
}

export async function cancelRun(run: GhRunner, target: GithubTarget): Promise<{ requested: true }> {
  const checked = runTarget(target);
  await mutate(run, ["api", "-X", "POST", `repos/${checked.path}/actions/runs/${checked.number}/cancel`, ...API_VERSION]);
  return { requested: true };
}

export async function rerunRun(
  run: GhRunner,
  target: GithubTarget,
  mode: "all" | "failed",
  jobId?: number,
): Promise<{ requested: true }> {
  const checked = runTarget(target);
  if (mode !== "all" && mode !== "failed") throw new Error("mode must be all or failed.");
  let path: string;
  if (jobId !== undefined) {
    positiveInteger(jobId, "job id");
    const job = await getRecord(run, `repos/${checked.path}/actions/jobs/${jobId}`);
    if (job.id !== jobId || job.run_id !== checked.number) throw new Error(`Job ${jobId} does not belong to run ${checked.number}.`);
    path = `repos/${checked.path}/actions/jobs/${jobId}/rerun`;
  } else {
    path = `repos/${checked.path}/actions/runs/${checked.number}/${mode === "failed" ? "rerun-failed-jobs" : "rerun"}`;
  }
  await mutate(run, ["api", "-X", "POST", path, ...API_VERSION]);
  return { requested: true };
}
