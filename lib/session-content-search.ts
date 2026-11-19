import { createReadStream, promises as fs } from "fs";
import { createInterface } from "readline";
import { listAllSessions } from "./session-reader";
import {
  compileSearchQuery,
  CONTENT_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
  type SearchField,
} from "./session-search";
export const MAX_CONTENT_CACHE_ENTRIES = 200;
export const MAX_SESSION_SEARCH_QUERY_LENGTH = 500;

interface ContentCacheEntry {
  version: string;
  field: Promise<SearchField>;
}

declare global {
  var __ompSessionContentSearchCache: Map<string, ContentCacheEntry> | undefined;
}

const PARSE_CONCURRENCY = 4;

interface SearchEntry {
  id: string;
  parentId: string | null;
  type: string;
  texts?: string[];
  firstKeptEntryId?: string;
}

const PROJECTED_LINE_MAX = 64 * 1024;
const SCAN_SLICE = 64 * 1024;
async function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

async function stringEnd(source: string, start: number): Promise<number> {
  if (source[start] !== "\"") return -1;
  let nextYield = start + SCAN_SLICE;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === "\"") return index + 1;
    if (index >= nextYield) {
      await yieldToEventLoop();
      nextYield = index + SCAN_SLICE;
    }
  }
  return -1;
}

async function valueEnd(source: string, start: number): Promise<number> {
  if (source[start] === "\"") return stringEnd(source, start);
  if (source[start] === "{" || source[start] === "[") {
    let depth = 0;
    let nextYield = start + SCAN_SLICE;
    for (let index = start; index < source.length; index++) {
      if (source[index] === "\"") {
        index = (await stringEnd(source, index)) - 1;
        if (index < 0) return -1;
      } else if (source[index] === "{" || source[index] === "[") {
        depth++;
      } else if (source[index] === "}" || source[index] === "]") {
        if (--depth === 0) return index + 1;
      }
      if (index >= nextYield) {
        await yieldToEventLoop();
        nextYield = index + SCAN_SLICE;
      }
    }
    return -1;
  }
  let index = start;
  let nextYield = start + SCAN_SLICE;
  while (index < source.length && source[index] !== "," && source[index] !== "}" && source[index] !== "]") {
    index++;
    if (index >= nextYield) {
      await yieldToEventLoop();
      nextYield = index + SCAN_SLICE;
    }
  }
  return index;
}

function skipSpace(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source.charCodeAt(index);
    if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
    index++;
  }
  return index;
}

/** Start of one direct object's field value, ignoring nested fields. */
async function directValue(source: string, objectStart: number, wanted: string): Promise<number> {
  let index = skipSpace(source, objectStart + 1);
  while (index < source.length && source[index] !== "}") {
    const keyEnd = await stringEnd(source, index);
    if (keyEnd < 0) return -1;
    let key: unknown;
    try {
      key = JSON.parse(source.slice(index, keyEnd));
    } catch {
      return -1;
    }
    index = skipSpace(source, keyEnd);
    if (source[index] !== ":") return -1;
    index = skipSpace(source, index + 1);
    if (key === wanted) return index;
    index = await valueEnd(source, index);
    if (index < 0) return -1;
    index = skipSpace(source, index);
    if (source[index] === ",") index = skipSpace(source, index + 1);
    else if (source[index] !== "}") return -1;
  }
  return -1;
}

async function directString(source: string, objectStart: number, key: string): Promise<string | null> {
  const start = await directValue(source, objectStart, key);
  const end = start >= 0 ? await stringEnd(source, start) : -1;
  if (end < 0) return null;
  try {
    return JSON.parse(source.slice(start, end)) as string;
  } catch {
    return null;
  }
}

/** Parse large excluded records structurally without decoding their payload. */
async function parseSearchRecord(line: string, legacy: boolean): Promise<Record<string, unknown>> {
  if (line.length <= PROJECTED_LINE_MAX) return JSON.parse(line) as Record<string, unknown>;
  const objectStart = skipSpace(line, 0);
  if (line[objectStart] !== "{") return JSON.parse(line) as Record<string, unknown>;
  const type = await directString(line, objectStart, "type");
  if (!type || type === "session" || type === "compaction") return JSON.parse(line) as Record<string, unknown>;
  const messageStart = type === "message" ? await directValue(line, objectStart, "message") : -1;
  const role = messageStart >= 0 && line[messageStart] === "{" ? await directString(line, messageStart, "role") : null;
  if (type === "message" && (!role || role === "user" || role === "assistant")) {
    return JSON.parse(line) as Record<string, unknown>;
  }
  if (legacy) return { type, ...(role ? { message: { role } } : {}) };
  const id = await directString(line, objectStart, "id");
  const parentStart = await directValue(line, objectStart, "parentId");
  const parentId = parentStart >= 0 && line.startsWith("null", parentStart)
    ? null
    : await directString(line, objectStart, "parentId");
  if (!id || parentStart < 0 || (parentId === null && !line.startsWith("null", parentStart))) {
    return JSON.parse(line) as Record<string, unknown>;
  }
  return { type, id, parentId, ...(role ? { message: { role } } : {}) };
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

function activeText(entries: SearchEntry[]): string {
  const byId = new Map<string, SearchEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const path: SearchEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  const compactionIdx = path.findLastIndex((entry) => entry.type === "compaction");
  const firstKeptEntryId = compactionIdx >= 0 ? path[compactionIdx].firstKeptEntryId : undefined;
  const firstKeptIdx = compactionIdx >= 0
    ? path.findIndex((entry, index) => index < compactionIdx && entry.id === firstKeptEntryId)
    : -1;
  const parts: string[] = [];
  for (let index = 0; index < path.length; index++) {
    if (compactionIdx >= 0 && (index === compactionIdx || index < (firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx))) continue;
    for (const text of path[index].texts ?? []) parts.push(text);
  }
  return parts.join("\n");
}

/** Active conversation's user and assistant text only: tool output and thinking would drown real matches. */
async function extractTranscriptText(filePath: string): Promise<string> {
  const entries: SearchEntry[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let legacy = false;
  try {
    for await (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = await parseSearchRecord(line, legacy);
      } catch {
        continue;
      }
      if (record.type === "title") continue;
      if (record.type === "session") {
        legacy = record.version == null || record.version === 1;
        continue;
      }
      if (typeof record.type !== "string") continue;
      const id = legacy ? `legacy:${entries.length}` : record.id;
      const parentId = legacy ? entries.at(-1)?.id ?? null : record.parentId;
      if (typeof id !== "string" || (parentId !== null && typeof parentId !== "string")) continue;
      const message = record.message && typeof record.message === "object"
        ? record.message as { role?: unknown; content?: unknown }
        : null;
      const role = typeof message?.role === "string" ? message.role : undefined;
      let firstKeptEntryId = typeof record.firstKeptEntryId === "string" ? record.firstKeptEntryId : undefined;
      if (legacy && record.type === "compaction" && typeof record.firstKeptEntryIndex === "number") {
        firstKeptEntryId = entries[record.firstKeptEntryIndex - 1]?.id;
      }
      entries.push({
        id,
        parentId,
        type: record.type,
        ...(role === "user" || role === "assistant" ? { texts: textBlocks(message?.content) } : {}),
        ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return activeText(entries);
}

function touchCacheEntry(cache: Map<string, ContentCacheEntry>, key: string, entry: ContentCacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CONTENT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

// shortcut: holds every session's extracted text in memory (~1% of file size) and
// re-reads a whole file when it changes; move to an on-disk index if installs outgrow that.
export async function transcriptField(filePath: string, cache: Map<string, ContentCacheEntry>): Promise<SearchField | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache.delete(filePath);
    return null;
  }
  const version = `${stat.size}:${stat.mtimeMs}`;
  let entry = cache.get(filePath);
  if (entry?.version === version) {
    touchCacheEntry(cache, filePath, entry);
    return entry.field.catch(() => null);
  }
  entry = { version, field: extractTranscriptText(filePath).then((text) => searchField(text, CONTENT_WEIGHT)) };
  touchCacheEntry(cache, filePath, entry);
  // A failed read must not stay cached.
  entry.field.catch(() => { if (cache.get(filePath) === entry) cache.delete(filePath); });
  return entry.field.catch(() => null);
}

/**
 * Yields matching session ids with their scores (titles outrank transcript
 * matches), one batch per group of scanned files, so callers can stream hits.
 * Every group yields, even with no hits: a caller stopping the iteration
 * (`return()` waits for the pending `next()`) then stops after that group.
 */
export async function* searchSessions(rawQuery: string): AsyncGenerator<Record<string, number>> {
  const query = compileSearchQuery(rawQuery);
  if (!query) return;
  const sessions = await listAllSessions();
  const cache = (globalThis.__ompSessionContentSearchCache ??= new Map());
  const listed = new Set(sessions.map((s) => s.path));
  for (const path of cache.keys()) if (!listed.has(path)) cache.delete(path);

  for (let i = 0; i < sessions.length; i += PARSE_CONCURRENCY) {
    const scores: Record<string, number> = {};
    await Promise.all(sessions.slice(i, i + PARSE_CONCURRENCY).map(async (session) => {
      const fields = [searchField(session.name ?? "", TITLE_WEIGHT)];
      const content = await transcriptField(session.path, cache);
      if (content) fields.push(content);
      const score = scoreSearchFields(fields, query);
      if (score !== null) scores[session.id] = score;
    }));
    yield scores;
  }
}
