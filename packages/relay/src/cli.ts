import { readFileSync } from "node:fs";
import { Store } from "./store.ts";

const [command, handle, ...rest] = process.argv.slice(2);
const store = new Store(process.env.PARLEY_DB ?? "parley.db");

if (command === "create-user" && handle) {
  const token = store.createUser(handle, rest.join(" ") || handle);
  console.log(`Created @${handle}. Token (shown once):\n${token}`);
} else if (command === "set-rules" && handle && rest[0]) {
  store.setRules(handle, readFileSync(rest[0], "utf8"));
  console.log(`Rules updated for @${handle}.`);
} else {
  console.error("Usage:\n  create-user <handle> [display name]\n  set-rules <handle> <rules.yaml>");
  process.exitCode = 1;
}
