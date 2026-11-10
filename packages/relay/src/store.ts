import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Task } from "@a2a-js/sdk";
import { DEFAULT_RULES_YAML, isValidHandle, parseRules } from "@parley/core";

export type User = {
  handle: string;
  displayName: string;
  rulesYaml: string;
  ntfyTopic: string | null;
};

export type Stage = "new" | "awaiting_owner" | "answered" | "refused";

export type OwnerState = {
  taskId: string;
  tenant: string;
  stage: Stage;
  topic: string | null;
  draft: string | null;
  reasons: string[];
};

export type StoredTask = { task: Task; tenant: string; caller: string; createdAt: string };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        handle TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        rules_yaml TEXT NOT NULL,
        ntfy_topic TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        caller TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks (tenant, created_at);
      CREATE INDEX IF NOT EXISTS tasks_caller ON tasks (caller, created_at);
      CREATE TABLE IF NOT EXISTS owner_state (
        task_id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        stage TEXT NOT NULL,
        topic TEXT,
        draft TEXT,
        reasons TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        handle TEXT NOT NULL,
        task_id TEXT,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_handle ON events (handle, id);
    `);
  }

  createUser(handle: string, displayName: string): string {
    if (!isValidHandle(handle)) throw new Error("Invalid handle: 2-32 chars, a-z 0-9 _ -");
    const token = `pk_${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare(
        "INSERT INTO users (handle, display_name, token_hash, rules_yaml, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(handle, displayName, hashToken(token), DEFAULT_RULES_YAML, new Date().toISOString());
    return token;
  }

  userByToken(token: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE token_hash = ?").get(hashToken(token));
    return row ? toUser(row) : undefined;
  }

  getUser(handle: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE handle = ?").get(handle);
    return row ? toUser(row) : undefined;
  }

  setRules(handle: string, yaml: string): void {
    parseRules(yaml);
    this.db.prepare("UPDATE users SET rules_yaml = ? WHERE handle = ?").run(yaml, handle);
  }

  setNtfyTopic(handle: string, topic: string | null): void {
    this.db.prepare("UPDATE users SET ntfy_topic = ? WHERE handle = ?").run(topic, handle);
  }

  saveTask(task: Task, tenant: string, caller: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (id, tenant, caller, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
         WHERE tasks.tenant = excluded.tenant AND tasks.caller = excluded.caller`,
      )
      .run(task.id, tenant, caller, JSON.stringify(Task.toJSON(task)), now, now);
  }

  loadTask(id: string): StoredTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? toStoredTask(row) : undefined;
  }

  listTasks(filter: { tenant?: string; caller?: string }, limit = 50): StoredTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ($tenant IS NULL OR tenant = $tenant) AND ($caller IS NULL OR caller = $caller)
         ORDER BY created_at DESC LIMIT $limit`,
      )
      .all({ $tenant: filter.tenant ?? null, $caller: filter.caller ?? null, $limit: limit });
    return rows.map(toStoredTask);
  }

  countQuestionsSince(tenant: string, caller: string, since: Date): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE tenant = ? AND caller = ? AND created_at >= ?")
      .get(tenant, caller, since.toISOString()) as { n: number };
    return row.n;
  }

  setOwnerState(s: OwnerState): void {
    this.db
      .prepare(
        `INSERT INTO owner_state (task_id, tenant, stage, topic, draft, reasons) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET stage = excluded.stage, topic = excluded.topic,
           draft = excluded.draft, reasons = excluded.reasons`,
      )
      .run(s.taskId, s.tenant, s.stage, s.topic, s.draft, JSON.stringify(s.reasons));
  }

  getOwnerState(taskId: string): OwnerState | undefined {
    const row = this.db.prepare("SELECT * FROM owner_state WHERE task_id = ?").get(taskId);
    return row ? toOwnerState(row) : undefined;
  }

  /** Moves a task between stages only if it is still in `from`, so two answerers can't both win. */
  transition(taskId: string, from: Stage[], next: Omit<OwnerState, "taskId" | "tenant">): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE owner_state SET stage = ?, topic = ?, draft = ?, reasons = ?
         WHERE task_id = ? AND stage IN (${placeholders})`,
      )
      .run(next.stage, next.topic, next.draft, JSON.stringify(next.reasons), taskId, ...from);
    return result.changes === 1;
  }

  inbox(tenant: string): (StoredTask & { owner: OwnerState })[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, o.task_id, o.stage, o.topic, o.draft, o.reasons FROM tasks t
         JOIN owner_state o ON o.task_id = t.id
         WHERE t.tenant = ? AND o.stage IN ('new', 'awaiting_owner') ORDER BY t.created_at`,
      )
      .all(tenant);
    return rows.map((r) => ({ ...toStoredTask(r), owner: toOwnerState(r) }));
  }

  log(handle: string, taskId: string | null, actor: string, kind: string, detail: unknown): void {
    this.db
      .prepare("INSERT INTO events (handle, task_id, actor, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(handle, taskId, actor, kind, JSON.stringify(detail), new Date().toISOString());
  }

  events(handle: string, limit = 100) {
    return this.db
      .prepare("SELECT task_id, actor, kind, detail, at FROM events WHERE handle = ? ORDER BY id DESC LIMIT ?")
      .all(handle, limit)
      .map((r) => ({
        threadId: r.task_id as string | null,
        actor: r.actor as string,
        kind: r.kind as string,
        detail: JSON.parse(r.detail as string) as unknown,
        at: r.at as string,
      }));
  }
}

type Row = Record<string, unknown>;

function toUser(r: Row): User {
  return {
    handle: r.handle as string,
    displayName: r.display_name as string,
    rulesYaml: r.rules_yaml as string,
    ntfyTopic: (r.ntfy_topic as string | null) ?? null,
  };
}

function toStoredTask(r: Row): StoredTask {
  return {
    task: Task.fromJSON(JSON.parse(r.json as string)),
    tenant: r.tenant as string,
    caller: r.caller as string,
    createdAt: r.created_at as string,
  };
}

function toOwnerState(r: Row): OwnerState {
  return {
    taskId: r.task_id as string,
    tenant: r.tenant as string,
    stage: r.stage as Stage,
    topic: (r.topic as string | null) ?? null,
    draft: (r.draft as string | null) ?? null,
    reasons: JSON.parse(r.reasons as string) as string[],
  };
}
