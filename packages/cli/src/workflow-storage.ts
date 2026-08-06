import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  RunSchema,
  TraceEventSchema,
  type AgentResult,
  type Run,
  type TraceEvent,
} from "./workflow";

const mode = 0o600;
const privateMode = 0o700;
const iso = () => new Date().toISOString();

export type RunFiles = {
  directory: string;
  systemPrompt: string;
  userPrompt: string;
  rawStream: string;
  result: string;
  metadata: string;
};

export type RunRecord = Run & {
  repositoryRoot: string;
  files: RunFiles;
  childPid?: number;
  sessionId?: string;
  processIdentity?: string;
  /** Metadata captured at creation time (request/agent are included by the CLI). */
  metadata?: unknown;
};

export type RunPage = Readonly<{
  runs: RunRecord[];
  /** SQLite rowid cursor for stable newest-first polling. */
  nextCursor?: number;
}>;

export type TracePage = Readonly<{
  events: Array<TraceEvent & { id: number }>;
  /** SQLite row id; pass as `after` to receive only newer events. */
  nextCursor?: number;
  hasMore: boolean;
}>;

export type RunListQuery = Readonly<{ limit?: number; before?: number }>;
export type TraceQuery = Readonly<{ after?: number; limit?: number }>;
export type ChangeToken = Readonly<{
  latestRunRowid: number;
  latestRunActivity: string;
  latestTraceRowid: number;
}>;
export type PublicRun = Pick<Run, "id" | "status" | "startedAt" | "finishedAt" | "failure"> & {
  metadata?: { request?: string; agentName?: string };
};

export type RunInit = {
  systemPrompt: string;
  userPrompt: string;
  metadata?: unknown;
};

export type AgentProcess = { agentName: string; pid?: number; sessionId?: string };

function runId() {
  return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function atomic(file: string, contents: string) {
  const temporary = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
    await chmod(file, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class WorkflowStorage {
  readonly database: Database;
  readonly root: string;
  readonly factoryDirectory: string;

  private constructor(root: string, database: Database) {
    this.root = root;
    this.factoryDirectory = join(root, ".factory");
    this.database = database;
  }

  static async open(repositoryRoot: string) {
    const factory = join(repositoryRoot, ".factory");
    await mkdir(join(factory, "runs"), { recursive: true, mode: privateMode });
    await chmod(factory, privateMode);
    await chmod(join(factory, "runs"), privateMode);
    const databasePath = join(factory, "workflow.sqlite");
    const database = new Database(databasePath, { create: true });
    await chmod(databasePath, mode);
    const storage = new WorkflowStorage(repositoryRoot, database);
    storage.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    storage.migrate();
    return storage;
  }

  private migrate() {
    const version =
      this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0;
    if (version < 1) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, repository_root TEXT NOT NULL, status TEXT NOT NULL,
            started_at TEXT, finished_at TEXT, failure_json TEXT,
            system_prompt_path TEXT NOT NULL, user_prompt_path TEXT NOT NULL,
            raw_stream_path TEXT NOT NULL, result_path TEXT NOT NULL, metadata_path TEXT NOT NULL,
            child_pid INTEGER, session_id TEXT, process_identity TEXT
          );
          CREATE TABLE IF NOT EXISTS agents (
            run_id TEXT NOT NULL, agent_name TEXT NOT NULL, started_at TEXT, finished_at TEXT,
            child_pid INTEGER, session_id TEXT, PRIMARY KEY (run_id, agent_name),
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS trace_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL,
            type TEXT NOT NULL, agent_name TEXT, tool TEXT, status TEXT, payload_json TEXT NOT NULL,
             input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
             cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER,
            cost_amount REAL, cost_currency TEXT,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
          );
           CREATE INDEX IF NOT EXISTS trace_events_run ON trace_events(run_id, id);
           CREATE INDEX IF NOT EXISTS runs_newest ON runs(id, started_at DESC);
          PRAGMA user_version = 1;
        `);
      })();
    }
    try {
      this.database.exec("ALTER TABLE runs ADD COLUMN process_identity TEXT");
    } catch {
      /* already present */
    }
    for (const column of ["reasoning_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      try {
        this.database.exec(`ALTER TABLE trace_events ADD COLUMN ${column} INTEGER`);
      } catch {
        /* already present */
      }
    }
  }

  async createRun(input: RunInit): Promise<RunRecord> {
    const id = runId();
    const directory = join(this.factoryDirectory, "runs", id);
    try {
      await mkdir(directory, { recursive: true, mode: privateMode });
      await chmod(directory, privateMode);
      const files: RunFiles = {
        directory,
        systemPrompt: join(directory, "system-prompt.txt"),
        userPrompt: join(directory, "user-prompt.txt"),
        rawStream: join(directory, "stream.jsonl"),
        result: join(directory, "result.json"),
        metadata: join(directory, "metadata.json"),
      };
      await atomic(files.systemPrompt, input.systemPrompt);
      await atomic(files.userPrompt, input.userPrompt);
      await atomic(files.rawStream, "");
      // result.json is created only after a valid structured result is received.
      await atomic(files.metadata, JSON.stringify(input.metadata ?? {}, null, 2) + "\n");
      this.database
        .query(`INSERT INTO runs
        (id, repository_root, status, system_prompt_path, user_prompt_path, raw_stream_path, result_path, metadata_path)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`)
        .run(
          id,
          this.root,
          files.systemPrompt,
          files.userPrompt,
          files.rawStream,
          files.result,
          files.metadata,
        );
      return this.getRun(id)!;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  startRun(id: string, at = iso()) {
    this.database.transaction(() => {
      const result = this.database
        .query("UPDATE runs SET status='running', started_at=? WHERE id=? AND status='pending'")
        .run(at, id);
      if (result.changes !== 1) throw Error(`Cannot start run: ${id}`);
      this.appendTrace({ runId: id, at, type: "run_started" });
    })();
    return this.getRun(id);
  }

  finishRun(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    failure?: Run["failure"],
    at = iso(),
  ) {
    const current = this.getRun(id);
    if (!current || !current.startedAt) throw Error(`Cannot finish run: ${id}`);
    const candidate = {
      id,
      status,
      startedAt: current.startedAt,
      finishedAt: at,
      ...(failure ? { failure } : {}),
    };
    RunSchema.parse(candidate);
    this.database.transaction(() => {
      const result = this.database
        .query(
          "UPDATE runs SET status=?, finished_at=?, failure_json=? WHERE id=? AND status='running'",
        )
        .run(status, at, failure ? JSON.stringify(failure) : null, id);
      if (result.changes !== 1) throw Error(`Cannot finish run: ${id}`);
      this.appendTrace({ runId: id, at, type: "run_finished", status });
    })();
    return this.getRun(id);
  }

  setAgentProcess(runId: string, processInfo: AgentProcess & { identity?: string }) {
    const sessionId = processInfo.sessionId || this.getRun(runId)?.sessionId;
    this.database
      .query(`INSERT INTO agents(run_id, agent_name, child_pid, session_id, started_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, agent_name) DO UPDATE SET child_pid=excluded.child_pid, session_id=excluded.session_id`)
      .run(runId, processInfo.agentName, processInfo.pid ?? null, sessionId ?? null, iso());
    this.database
      .query("UPDATE runs SET child_pid=?, session_id=?, process_identity=? WHERE id=?")
      .run(processInfo.pid ?? null, sessionId ?? null, processInfo.identity ?? null, runId);
  }

  clearAgentProcess(runId: string) {
    this.database
      .query("UPDATE runs SET child_pid=NULL, process_identity=NULL WHERE id=?")
      .run(runId);
  }

  failIfRunning(runId: string, failure: Run["failure"]) {
    const current = this.getRun(runId);
    if (!current || current.status !== "running") return current;
    try {
      return this.finishRun(runId, "failed", failure);
    } catch {
      return this.getRun(runId);
    }
  }

  appendTrace(event: TraceEvent) {
    const value = TraceEventSchema.parse(event);
    const usage = value.usage,
      cost = value.cost;
    this.database
      .query(`INSERT INTO trace_events
      (run_id, at, type, agent_name, tool, status, payload_json, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_amount, cost_currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        value.runId,
        value.at,
        value.type,
        "agentName" in value ? (value.agentName ?? null) : null,
        value.type === "tool_call" ? value.tool : null,
        value.type === "run_finished" ? value.status : null,
        JSON.stringify(value),
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.reasoning ?? null,
        usage?.cacheRead ?? null,
        usage?.cacheWrite ?? null,
        usage?.total ?? null,
        cost?.amount ?? null,
        cost?.currency ?? null,
      );
  }

  async appendRaw(runId: string, value: unknown) {
    const record = this.getRun(runId);
    if (!record) throw Error(`Run not found: ${runId}`);
    const handle = await open(record.files.rawStream, "a", mode);
    try {
      await handle.write(JSON.stringify(value) + "\n");
    } finally {
      await handle.close();
    }
  }

  async writeResult(runId: string, result: AgentResult | unknown) {
    const record = this.getRun(runId);
    if (!record) throw Error(`Run not found: ${runId}`);
    await atomic(record.files.result, JSON.stringify(result, null, 2) + "\n");
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.database.query<any, [string]>("SELECT * FROM runs WHERE id=?").get(id);
    if (!row) return undefined;
    let metadata: unknown;
    try {
      metadata = JSON.parse(readFileSync(row.metadata_path, "utf8"));
    } catch {
      /* Metadata is supplementary; a missing/corrupt file must not hide a run. */
    }
    const run: RunRecord = {
      id: row.id,
      status: row.status,
      repositoryRoot: row.repository_root,
      files: {
        directory: join(this.factoryDirectory, "runs", row.id),
        systemPrompt: row.system_prompt_path,
        userPrompt: row.user_prompt_path,
        rawStream: row.raw_stream_path,
        result: row.result_path,
        metadata: row.metadata_path,
      },
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(row.failure_json ? { failure: JSON.parse(row.failure_json) } : {}),
      ...(row.child_pid ? { childPid: row.child_pid } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.process_identity ? { processIdentity: row.process_identity } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    return run;
  }

  trace(runId: string): TraceEvent[] {
    return this.database
      .query<{ payload_json: string }, [string]>(
        "SELECT payload_json FROM trace_events WHERE run_id=? ORDER BY id",
      )
      .all(runId)
      .map((row) => TraceEventSchema.parse(JSON.parse(row.payload_json)));
  }

  /** Lists runs newest-first. Cursor is the last seen SQLite rowid, avoiding offset drift. */
  listRuns(query: RunListQuery = {}): RunPage {
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
    const rows = query.before
      ? this.database
          .query<any, [number, number]>(
            "SELECT rowid, * FROM runs WHERE rowid < ? ORDER BY rowid DESC LIMIT ?",
          )
          .all(query.before, limit + 1)
      : this.database
          .query<any, [number]>("SELECT rowid, * FROM runs ORDER BY rowid DESC LIMIT ?")
          .all(limit + 1);
    const page = rows.slice(0, limit).map((row) => this.getRun(row.id)!);
    return { runs: page, ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.rowid } : {}) };
  }

  /** Incremental, append-ordered trace query. `after` is exclusive and stable across polling. */
  tracePage(runId: string, query: TraceQuery = {}): TracePage {
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const after = query.after ?? 0;
    const rows = this.database
      .query<{ id: number; payload_json: string }, [string, number, number]>(
        "SELECT id, payload_json FROM trace_events WHERE run_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(runId, after, limit + 1);
    const events = rows
      .slice(0, limit)
      .map((row) => ({ ...TraceEventSchema.parse(JSON.parse(row.payload_json)), id: row.id }));
    return {
      events,
      hasMore: rows.length > limit,
      ...(events.length ? { nextCursor: rows[Math.min(rows.length, limit) - 1]!.id } : {}),
    };
  }

  traceCursor(runId: string) {
    return this.database
      .query<{ id: number }, [string]>(
        "SELECT id FROM trace_events WHERE run_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(runId)?.id;
  }

  /** Cheap database-only token for live UI polling. */
  changeToken(): ChangeToken {
    return this.database
      .query<{ latestRunRowid: number; latestRunActivity: string; latestTraceRowid: number }, []>(
        `SELECT COALESCE((SELECT MAX(rowid) FROM runs), 0) AS latestRunRowid,
                COALESCE((SELECT MAX(activity) FROM
                  (SELECT COALESCE(finished_at, started_at, '0') AS activity FROM runs)), '0') AS latestRunActivity,
                COALESCE((SELECT MAX(id) FROM trace_events), 0) AS latestTraceRowid`,
      )
      .get()!;
  }

  close() {
    this.database.close();
  }
}

export const generateRunId = runId;
export const openWorkflowStorage = WorkflowStorage.open;
