import { createHmac, timingSafeEqual } from "node:crypto";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor } from "@a2a-js/sdk/server";
import { parseRules, postcheck, precheck, resolveSender, type Decision } from "@parley/core";
import { stateName, textOf, withStatus } from "./a2a.ts";
import type { Notifier } from "./notify.ts";
import type { OwnerState, Store, StoredTask, User } from "./store.ts";

const APPROVAL_TTL_MS = 7 * 24 * 3600 * 1000;

export type ThreadView = {
  threadId: string;
  from: string;
  to: string;
  status: string;
  question: string;
  answer: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export class ParleyService {
  readonly store: Store;
  private readonly notifier: Notifier;
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(store: Store, notifier: Notifier, baseUrl: string, secret: string) {
    this.store = store;
    this.notifier = notifier;
    this.baseUrl = baseUrl;
    this.secret = secret;
  }

  readonly executor: AgentExecutor = {
    execute: async (ctx, bus) => {
      const tenant = ctx.context.tenant;
      const caller = ctx.context.user?.userName;
      const owner = tenant ? this.store.getUser(tenant) : undefined;
      if (!owner || !caller) throw new Error("Unknown recipient");

      const rules = parseRules(owner.rulesYaml);
      const sender = resolveSender(rules, caller);
      const recent = this.store.countQuestionsSince(tenant!, caller, new Date(Date.now() - 24 * 3600 * 1000));
      const pre = precheck(rules, sender, recent);

      const base: Task = {
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: undefined,
        artifacts: [],
        history: [ctx.userMessage],
        metadata: { parley: { from: caller, to: owner.handle } },
      };
      const task =
        pre.action === "refuse"
          ? withStatus(base, TaskState.TASK_STATE_REJECTED, refusalText(owner))
          : withStatus(base, TaskState.TASK_STATE_SUBMITTED);

      this.store.setOwnerState({
        taskId: task.id,
        tenant: owner.handle,
        stage: pre.action === "refuse" ? "refused" : "new",
        topic: null,
        draft: null,
        reasons: pre.reasons,
      });
      this.store.log(owner.handle, task.id, caller, "question.received", { text: textOf(ctx.userMessage), precheck: pre });
      this.store.log(caller, task.id, caller, "question.sent", { to: owner.handle });

      bus.publish(AgentEvent.task(task));
      bus.finished();

      if (pre.action !== "refuse") {
        await this.notifier.notify(owner, {
          title: `New question from @${caller}`,
          body: `${truncate(textOf(ctx.userMessage), 200)}\nYour AI will answer it within your sharing rules.`,
        });
      }
    },
    cancelTask: async () => {
      throw new Error("Cancel is not supported yet");
    },
  };

  inbox(owner: User) {
    return this.store.inbox(owner.handle).map((s) => ({
      threadId: s.task.id,
      from: s.caller,
      question: textOf(s.task.history[0]),
      receivedAt: s.createdAt,
      stage: s.owner.stage,
      ...(s.owner.stage === "awaiting_owner" ? { waitingFor: s.owner.reasons } : {}),
    }));
  }

  /** Called by the owner's AI. The draft goes out only if the code-enforced rules allow it. */
  async answer(owner: User, threadId: string, topic: string, text: string): Promise<Decision & { sent: boolean }> {
    const s = this.ownedTask(owner, threadId);
    const rules = parseRules(owner.rulesYaml);
    const decision = postcheck(rules, resolveSender(rules, s.caller), topic, text);

    if (decision.action === "answer") {
      this.claim(s, ["new"], { stage: "answered", topic, draft: text, reasons: decision.reasons });
      await this.finish(owner, s, TaskState.TASK_STATE_COMPLETED, text, "agent");
      return { ...decision, sent: true };
    }
    if (decision.action === "refuse") {
      this.claim(s, ["new"], { stage: "refused", topic, draft: text, reasons: decision.reasons });
      await this.finish(owner, s, TaskState.TASK_STATE_REJECTED, refusalText(owner), "agent");
      if (decision.reasons.some((r) => r.startsWith("hard limit"))) {
        await this.notifier.notify(owner, {
          title: `Blocked an answer to @${s.caller}`,
          body: `Your AI drafted an answer that hit a hard limit (${decision.reasons.join(", ")}). It was not sent.`,
        });
      }
      return { ...decision, sent: false };
    }
    await this.escalate(owner, s, topic, text, decision.reasons);
    return { ...decision, sent: false };
  }

  async escalateById(owner: User, threadId: string, reason: string): Promise<void> {
    await this.escalate(owner, this.ownedTask(owner, threadId), null, null, [reason]);
  }

  /** Human decision from the signed approval page. */
  async resolve(threadId: string, decision: "send" | "refuse", text: string | undefined): Promise<void> {
    const s = this.store.loadTask(threadId);
    const owner = s && this.store.getUser(s.tenant);
    const state = s && this.store.getOwnerState(threadId);
    if (!s || !owner || !state) throw new HttpError(404, "Thread not found");
    const reply = decision === "send" ? (text?.trim() || state.draft || "") : refusalText(owner);
    if (decision === "send" && !reply) throw new HttpError(400, "Write an answer before sending");
    this.claim(s, ["awaiting_owner"], {
      stage: decision === "send" ? "answered" : "refused",
      topic: state.topic,
      draft: reply,
      reasons: [...state.reasons, `owner ${decision === "send" ? "approved" : "refused"}`],
    });
    await this.finish(
      owner,
      s,
      decision === "send" ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_REJECTED,
      reply,
      "owner",
    );
  }

  pendingApproval(threadId: string) {
    const s = this.store.loadTask(threadId);
    const state = this.store.getOwnerState(threadId);
    if (!s || !state || state.stage !== "awaiting_owner") return undefined;
    return { from: s.caller, to: s.tenant, question: textOf(s.task.history[0]), draft: state.draft, reasons: state.reasons };
  }

  threads(user: User): ThreadView[] {
    const sent = this.store.listTasks({ caller: user.handle });
    const received = this.store.listTasks({ tenant: user.handle });
    const seen = new Set<string>();
    return [...sent, ...received]
      .filter((s) => !seen.has(s.task.id) && seen.add(s.task.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(threadView);
  }

  thread(user: User, threadId: string): ThreadView & { history: { role: string; text: string }[] } {
    const s = this.store.loadTask(threadId);
    if (!s || (s.caller !== user.handle && s.tenant !== user.handle)) throw new HttpError(404, "Thread not found");
    return {
      ...threadView(s),
      history: s.task.history.map((m) => ({ role: m.role === Role.ROLE_USER ? s.caller : s.tenant, text: textOf(m) })),
    };
  }

  approvalUrl(threadId: string, now = Date.now()): string {
    const exp = now + APPROVAL_TTL_MS;
    return `${this.baseUrl}/approve/${threadId}?exp=${exp}&sig=${this.sign(threadId, exp)}`;
  }

  verifyApproval(threadId: string, exp: string | undefined, sig: string | undefined): boolean {
    const expiry = Number(exp);
    if (!sig || !Number.isFinite(expiry) || expiry < Date.now()) return false;
    const expected = Buffer.from(this.sign(threadId, expiry));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(threadId: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`approve:${threadId}:${exp}`).digest("base64url");
  }

  private ownedTask(owner: User, threadId: string): StoredTask {
    const s = this.store.loadTask(threadId);
    if (!s || s.tenant !== owner.handle) throw new HttpError(404, "Thread not found");
    return s;
  }

  private claim(s: StoredTask, from: OwnerState["stage"][], next: Omit<OwnerState, "taskId" | "tenant">) {
    if (!this.store.transition(s.task.id, from, next)) {
      throw new HttpError(409, `Thread is no longer ${from.join(" or ")}`);
    }
  }

  private async escalate(owner: User, s: StoredTask, topic: string | null, draft: string | null, reasons: string[]) {
    this.claim(s, ["new"], { stage: "awaiting_owner", topic, draft, reasons });
    this.store.saveTask(
      withStatus(s.task, TaskState.TASK_STATE_WORKING, `${owner.displayName}'s agent is checking with ${owner.displayName}.`),
      s.tenant,
      s.caller,
    );
    this.store.log(owner.handle, s.task.id, "agent", "interruption", { reasons, draft });
    await this.notifier.notify(owner, {
      title: `@${s.caller} is waiting for your approval`,
      body: `Q: ${truncate(textOf(s.task.history[0]), 200)}\n${draft ? `Draft: ${truncate(draft, 200)}\n` : ""}Why: ${reasons.join("; ")}`,
      url: this.approvalUrl(s.task.id),
    });
  }

  private async finish(owner: User, s: StoredTask, state: TaskState, text: string, actor: string) {
    this.store.saveTask(withStatus(s.task, state, text), s.tenant, s.caller);
    this.store.log(owner.handle, s.task.id, actor, `thread.${stateName(state)}`, { text });
    this.store.log(s.caller, s.task.id, owner.handle, `thread.${stateName(state)}`, { text });
    const asker = this.store.getUser(s.caller);
    if (asker) {
      await this.notifier.notify(asker, {
        title: `@${owner.handle} replied`,
        body: `Q: ${truncate(textOf(s.task.history[0]), 120)}\nA: ${truncate(text, 300)}`,
      });
    }
  }
}

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409;

  constructor(status: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

function threadView(s: StoredTask): ThreadView {
  const state = s.task.status?.state;
  return {
    threadId: s.task.id,
    from: s.caller,
    to: s.tenant,
    status: stateName(state),
    question: textOf(s.task.history[0]),
    answer:
      state === TaskState.TASK_STATE_COMPLETED || state === TaskState.TASK_STATE_REJECTED
        ? textOf(s.task.status?.message)
        : null,
    createdAt: s.createdAt,
    updatedAt: s.task.status?.timestamp ?? null,
  };
}

function refusalText(owner: User): string {
  return `${owner.displayName}'s agent can't share that. You can contact ${owner.displayName} directly.`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
