import { randomUUID } from "node:crypto";
import { A2A_PROTOCOL_VERSION, AgentCard, Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import type { Store } from "./store.ts";

export function textOf(message: Message | undefined): string {
  return (message?.parts ?? [])
    .flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : []))
    .join("\n");
}

export function agentMessage(task: Task, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId: task.contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Applies a new status; a status message is also appended to history so the thread reads in order. */
export function withStatus(task: Task, state: TaskState, text?: string): Task {
  const message = text === undefined ? undefined : agentMessage(task, text);
  return {
    ...task,
    status: { state, message, timestamp: new Date().toISOString() },
    history: message ? [...task.history, message] : task.history,
  };
}

export const TERMINAL = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_FAILED]);

export function stateName(state: TaskState | undefined): string {
  return TaskState[state ?? TaskState.TASK_STATE_UNSPECIFIED]?.replace("TASK_STATE_", "").toLowerCase() ?? "unknown";
}

export function agentCard(baseUrl: string, tenant: string, displayName: string): AgentCard {
  return AgentCard.fromJSON({
    name: tenant ? `${displayName} (Parley delegate)` : "Parley relay",
    description: tenant
      ? `Delegate agent for ${displayName}. Answers questions within ${displayName}'s sharing rules and asks ${displayName} when needed. Answers can take minutes to hours: send with returnImmediately and poll GetTask.`
      : "Parley relay. Each user has their own agent card at /u/{handle}/.well-known/agent-card.json.",
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", tenant, protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    version: "0.0.1",
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { parley: { httpAuthSecurityScheme: { scheme: "Bearer", description: "Parley API token" } } },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: tenant
      ? [
          {
            id: "ask",
            name: "Ask a question",
            description: `Ask ${displayName} a question. The delegate answers from what ${displayName} has made available.`,
            tags: ["question", "delegate"],
          },
        ]
      : [],
  });
}

/** Scopes A2A reads to the caller: an asker sees only the tasks they created on that tenant. */
export class SqliteTaskStore implements TaskStore {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async save(task: Task, context: Parameters<TaskStore["save"]>[1]): Promise<void> {
    const caller = context.user?.userName;
    const tenant = context.tenant;
    if (!caller || !tenant) throw new Error("Task save without tenant or caller");
    this.store.saveTask(task, tenant, caller);
  }

  async load(taskId: string, context: Parameters<TaskStore["load"]>[1]): Promise<Task | undefined> {
    const stored = this.store.loadTask(taskId);
    if (!stored || stored.caller !== context.user?.userName) return undefined;
    if (context.tenant && stored.tenant !== context.tenant) return undefined;
    return stored.task;
  }

  async list(params: Parameters<TaskStore["list"]>[0], context: Parameters<TaskStore["list"]>[1]) {
    const caller = context.user?.userName;
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
    const tasks = caller
      ? this.store
          .listTasks({ tenant: context.tenant, caller }, pageSize)
          .map((s) => s.task)
          .filter((t) => !params.contextId || t.contextId === params.contextId)
      : [];
    return { tasks, nextPageToken: "", pageSize, totalSize: tasks.length };
  }
}
