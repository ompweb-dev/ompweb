import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getAgentDir } from "../omp/paths";

const UNCERTAIN = "The GitHub Actions write outcome is unknown. Inspect existing runs with github_run_list or github_read before deciding whether to try again; the operation was not replayed.";

/** Reserve before sending: a process death cannot turn the same tool request into another dispatch. */
export async function withActionReceipt(session: string, request: string, operation: string, args: unknown, perform: () => Promise<unknown>): Promise<unknown> {
  if (!request) throw new Error("GitHub Actions writes require a request identity.");
  const dir = join(getAgentDir(), "omp-web");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "github-action-receipts.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    db.exec("CREATE TABLE IF NOT EXISTS receipts (session TEXT NOT NULL, request TEXT NOT NULL, intent TEXT NOT NULL, result TEXT, PRIMARY KEY(session, request))");
    const intent = createHash("sha256").update(JSON.stringify([operation, args])).digest("hex");
    const inserted = db.prepare("INSERT OR IGNORE INTO receipts (session, request, intent) VALUES (?, ?, ?)").run(session, request, intent).changes;
    if (!inserted) {
      const row = db.prepare<{ intent: string; result: string | null }, [string, string]>("SELECT intent, result FROM receipts WHERE session = ? AND request = ?").get(session, request);
      if (row?.intent !== intent) throw new Error("GitHub Actions request identity was reused with different arguments.");
      if (row.result === null) throw new Error(UNCERTAIN);
      const saved = JSON.parse(row.result) as { value?: unknown; error?: string };
      if (saved.error) throw new Error(saved.error);
      return saved.value;
    }
    let result: { value?: unknown; error?: string };
    try {
      result = { value: await perform() };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    // If saving fails after the write, retain the pending receipt rather than allowing another write.
    try {
      db.prepare("UPDATE receipts SET result = ? WHERE session = ? AND request = ?").run(JSON.stringify(result), session, request);
    } catch {
      throw new Error(UNCERTAIN);
    }
    if (result.error) throw new Error(result.error);
    return result.value;
  } finally {
    db.close(true);
  }
}
