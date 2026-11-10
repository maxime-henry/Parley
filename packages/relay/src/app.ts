import { timingSafeEqual } from "node:crypto";
import { A2A_VERSION_HEADER, AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
  validateVersion,
  type User as A2AUser,
} from "@a2a-js/sdk/server";
import { parseRules } from "@parley/core";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { SqliteTaskStore, agentCard } from "./a2a.ts";
import { DefaultNotifier, type Notifier } from "./notify.ts";
import { HttpError, ParleyService } from "./service.ts";
import { Store, type User } from "./store.ts";

export type RelayOptions = {
  dbPath: string;
  baseUrl: string;
  secret: string;
  adminToken?: string;
  notifier?: Notifier;
};

type Env = { Variables: { user: User } };

export type { Notification, Notifier } from "./notify.ts";

const UNSUPPORTED_METHODS = new Set(["SendStreamingMessage", "SubscribeToTask", "CancelTask"]);
const MAX_WAIT_S = 25;

export function createRelay(options: RelayOptions) {
  const store = new Store(options.dbPath);
  const service = new ParleyService(store, options.notifier ?? new DefaultNotifier(), options.baseUrl, options.secret);
  const relayCard = agentCard(options.baseUrl, "", "Parley");
  const requestHandler = new DefaultRequestHandler(relayCard, new SqliteTaskStore(store), service.executor);
  const rpc = new JsonRpcTransportHandler(requestHandler);

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  const auth = async (c: Context<Env>, next: () => Promise<void>) => {
    const token = c.req.header("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const user = token ? store.userByToken(token) : undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", user);
    await next();
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/u/:handle/.well-known/agent-card.json", (c) => {
    const user = store.getUser(c.req.param("handle"));
    if (!user) return c.json({ error: "Not found" }, 404);
    return c.json(AgentCard.toJSON(agentCard(options.baseUrl, user.handle, user.displayName)) as object);
  });

  app.post("/a2a", auth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const id = body?.id ?? null;
    const rpcError = (code: number, message: string) => c.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (!body || typeof body !== "object") return rpcError(-32700, "Parse error");
    if (UNSUPPORTED_METHODS.has(body.method)) return rpcError(-32004, `${body.method} is not supported by Parley yet`);
    if (body.method === "SendMessage") {
      const tenant = body.params?.tenant;
      if (typeof tenant !== "string" || !store.getUser(tenant)) return rpcError(-32602, "Unknown recipient");
      if (body.params?.message?.taskId) return rpcError(-32602, "Follow-up messages are not supported yet");
    }

    const user = c.get("user");
    const caller: A2AUser = { isAuthenticated: true, userName: user.handle };
    const context = defaultServerCallContextBuilder({
      extensions: undefined,
      user: caller,
      headers: Object.fromEntries(c.req.raw.headers),
      requestedVersion: c.req.header(A2A_VERSION_HEADER) || undefined,
    });
    try {
      validateVersion(context.requestedVersion, relayCard, "JSONRPC");
      const result = await rpc.handle(body, context);
      if (Symbol.asyncIterator in (result as object)) return rpcError(-32004, "Streaming is not supported");
      return c.json(result);
    } catch (err) {
      return c.json({ jsonrpc: "2.0", id, error: JsonRpcTransportHandler.mapToJSONRPCError(err) });
    }
  });

  const me = new Hono<Env>();
  me.use(auth);

  me.get("/", (c) => {
    const u = c.get("user");
    return c.json({ handle: u.handle, displayName: u.displayName, agentCard: `${options.baseUrl}/u/${u.handle}/.well-known/agent-card.json` });
  });

  me.get("/inbox", async (c) => {
    const user = c.get("user");
    const wait = Math.min(Math.max(Number(c.req.query("wait") ?? 0) || 0, 0), MAX_WAIT_S);
    const deadline = Date.now() + wait * 1000;
    let items = service.inbox(user).filter((i) => i.stage === "new");
    while (items.length === 0 && Date.now() < deadline && !c.req.raw.signal.aborted) {
      await new Promise((r) => setTimeout(r, 1000));
      items = service.inbox(user).filter((i) => i.stage === "new");
    }
    const awaitingOwner = service.inbox(user).filter((i) => i.stage === "awaiting_owner");
    return c.json({ questions: items, awaitingOwner, rules: user.rulesYaml });
  });

  const AnswerBody = z.object({ topic: z.string().max(100), text: z.string().min(1).max(20_000) });
  me.post("/inbox/:id/answer", async (c) => {
    const { topic, text } = AnswerBody.parse(await c.req.json());
    return c.json(await service.answer(c.get("user"), c.req.param("id"), topic, text));
  });

  const EscalateBody = z.object({ reason: z.string().min(1).max(500) });
  me.post("/inbox/:id/escalate", async (c) => {
    const { reason } = EscalateBody.parse(await c.req.json());
    await service.escalateById(c.get("user"), c.req.param("id"), reason);
    return c.json({ ok: true });
  });

  me.get("/threads", (c) => c.json(service.threads(c.get("user"))));
  me.get("/threads/:id", (c) => c.json(service.thread(c.get("user"), c.req.param("id"))));
  me.get("/log", (c) => c.json(store.events(c.get("user").handle)));
  me.get("/rules", (c) => c.text(c.get("user").rulesYaml));

  // Rules are edited by the human (CLI/curl), not exposed as an MCP tool an injected AI could call.
  me.put("/rules", async (c) => {
    const yaml = await c.req.text();
    parseRules(yaml);
    store.setRules(c.get("user").handle, yaml);
    return c.json({ ok: true });
  });

  const NotifyBody = z.object({ ntfyTopic: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).nullable() });
  me.put("/notify", async (c) => {
    const { ntfyTopic } = NotifyBody.parse(await c.req.json());
    store.setNtfyTopic(c.get("user").handle, ntfyTopic);
    return c.json({ ok: true });
  });

  app.route("/me", me);

  const approvalHeaders = (c: Context) => {
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  };

  app.get("/approve/:id", (c) => {
    approvalHeaders(c);
    const id = c.req.param("id");
    const { exp, sig } = c.req.query();
    if (!service.verifyApproval(id, exp, sig)) return c.html(page("Link expired or invalid", html``), 403);
    const pending = service.pendingApproval(id);
    if (!pending) return c.html(page("Already handled", html`<p>This question has already been answered or refused.</p>`));
    return c.html(
      page(
        `@${pending.from} is asking`,
        html`<p class="q">${pending.question}</p>
          <p class="why">Your agent stopped because: ${pending.reasons.join("; ")}</p>
          <form method="post">
            <input type="hidden" name="exp" value="${exp}" />
            <input type="hidden" name="sig" value="${sig}" />
            <label for="text">Answer sent to @${pending.from}</label>
            <textarea id="text" name="text" rows="8">${pending.draft ?? ""}</textarea>
            <div class="actions">
              <button name="decision" value="send">Send answer</button>
              <button name="decision" value="refuse" class="secondary">Refuse politely</button>
            </div>
          </form>`,
      ),
    );
  });

  app.post("/approve/:id", async (c) => {
    approvalHeaders(c);
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    if (!service.verifyApproval(id, String(form.exp ?? ""), String(form.sig ?? ""))) {
      return c.html(page("Link expired or invalid", html``), 403);
    }
    const decision = form.decision === "send" ? "send" : "refuse";
    await service.resolve(id, decision, typeof form.text === "string" ? form.text : undefined);
    return c.html(page(decision === "send" ? "Answer sent" : "Refused", html`<p>You can close this tab.</p>`));
  });

  const CreateUser = z.object({ handle: z.string(), displayName: z.string().min(1).max(80) });
  app.post("/admin/users", async (c) => {
    if (!options.adminToken || !safeEqual(c.req.header("X-Admin-Token") ?? "", options.adminToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { handle, displayName } = CreateUser.parse(await c.req.json());
    if (store.getUser(handle)) return c.json({ error: "Handle taken" }, 409);
    return c.json({ handle, token: store.createUser(handle, displayName) }, 201);
  });

  return { app, store, service };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Parley · ${title}</title>
        <style>
          body { font: 16px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 4rem auto; padding: 0 2rem; color: #1d1d1f; }
          h1 { font-size: 1.4rem; }
          .q { font-size: 1.1rem; padding: 1rem; background: #f4f4f6; border-radius: 6px; white-space: pre-wrap; }
          .why { color: #6e6e73; font-size: .9rem; }
          label { display: block; font-weight: 600; margin: 1.5rem 0 .5rem; }
          textarea { width: 100%; font: inherit; padding: .75rem; box-sizing: border-box; }
          .actions { display: flex; gap: .75rem; margin-top: 1rem; }
          button { font: inherit; padding: .6rem 1.2rem; border: 0; border-radius: 6px; background: #1d1d1f; color: #fff; cursor: pointer; }
          button.secondary { background: #e8e8ed; color: #1d1d1f; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        ${body}
      </body>
    </html>`;
}
