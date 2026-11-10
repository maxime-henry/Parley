import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { createRelay } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);
const baseUrl = (process.env.PARLEY_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secret = process.env.PARLEY_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.PARLEY_SECRET) console.warn("PARLEY_SECRET not set: approval links will break on restart.");

const { app } = createRelay({
  dbPath: process.env.PARLEY_DB ?? "parley.db",
  baseUrl,
  secret,
  adminToken: process.env.PARLEY_ADMIN_TOKEN,
});

serve({ fetch: app.fetch, port }, () => console.log(`Parley relay on ${baseUrl}`));
