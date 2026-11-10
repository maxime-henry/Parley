import { randomUUID } from "node:crypto";
import { Role, TaskState, type Message } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

export type InboxItem = {
  threadId: string;
  from: string;
  question: string;
  receivedAt: string;
  stage: "new" | "awaiting_owner";
  waitingFor?: string[];
};

export type Inbox = { questions: InboxItem[]; awaitingOwner: InboxItem[]; rules: string };

export type AnswerResult = { action: "answer" | "ask" | "refuse"; reasons: string[]; sent: boolean };

export type Thread = {
  threadId: string;
  from: string;
  to: string;
  status: string;
  question: string;
  answer: string | null;
  createdAt: string;
  updatedAt: string | null;
};

/** Talks to the relay: A2A for asking other people's agents, the owner API for your own inbox. */
export class ParleyClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly authFetch: typeof fetch;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.authFetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${this.token}`);
      return fetch(input, { ...init, headers });
    };
  }

  async ask(handle: string, question: string): Promise<{ threadId: string; status: string }> {
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: this.authFetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: this.authFetch }),
    });
    const client = await factory.createFromUrl(
      `${this.baseUrl}/u/${encodeURIComponent(handle)}/.well-known/agent-card.json`,
      "",
    );
    const message: Message = {
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: question }, metadata: undefined, filename: "", mediaType: "text/plain" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    const result = await client.sendMessage({
      tenant: "",
      message,
      configuration: {
        acceptedOutputModes: ["text/plain"],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });
    if (!("status" in result)) throw new Error("Expected a task from the remote agent");
    const state = TaskState[result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? "unknown";
    return { threadId: result.id, status: state.replace("TASK_STATE_", "").toLowerCase() };
  }

  me() {
    return this.call<{ handle: string; displayName: string; agentCard: string }>("GET", "/me");
  }

  inbox(waitSeconds = 0) {
    return this.call<Inbox>("GET", `/me/inbox?wait=${waitSeconds}`);
  }

  answer(threadId: string, topic: string, text: string) {
    return this.call<AnswerResult>("POST", `/me/inbox/${encodeURIComponent(threadId)}/answer`, { topic, text });
  }

  escalate(threadId: string, reason: string) {
    return this.call<{ ok: true }>("POST", `/me/inbox/${encodeURIComponent(threadId)}/escalate`, { reason });
  }

  threads() {
    return this.call<Thread[]>("GET", "/me/threads");
  }

  thread(threadId: string) {
    return this.call<Thread & { history: { role: string; text: string }[] }>(
      "GET",
      `/me/threads/${encodeURIComponent(threadId)}`,
    );
  }

  async rules(): Promise<string> {
    const res = await this.authFetch(`${this.baseUrl}/me/rules`);
    if (!res.ok) throw new Error(`Relay returned ${res.status}`);
    return res.text();
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.authFetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Relay returned ${res.status}`);
    return data;
  }
}
