import type { Action, Rules, Trust } from "./rules.ts";

export type Decision = {
  action: Action;
  reasons: string[];
};

export type Sender = {
  handle: string;
  trust: Trust | "unknown";
};

export function resolveSender(rules: Rules, handle: string): Sender {
  const contact = rules.contacts.find((c) => c.handle === handle);
  return { handle, trust: contact?.trust ?? "unknown" };
}

/** Runs before any LLM sees the question. */
export function precheck(rules: Rules, sender: Sender, questionsLast24h: number): Decision {
  if (sender.trust === "blocked") return { action: "refuse", reasons: ["blocked contact"] };

  const limit =
    rules.contacts.find((c) => c.handle === sender.handle)?.maxQuestionsPerDay ?? rules.maxQuestionsPerDay;
  if (questionsLast24h >= limit) return { action: "refuse", reasons: [`rate limit (${limit}/day)`] };

  if (sender.trust === "unknown") {
    return rules.unknownContacts === "refuse"
      ? { action: "refuse", reasons: ["unknown contact"] }
      : { action: "ask", reasons: ["unknown contact"] };
  }
  return { action: "answer", reasons: [] };
}

const PROMISE =
  /\b(i|we)\s*(will|'ll|shall|can)\s+(do|deliver|commit|send|pay|attend|join|be there|meet|sign|take care)|\b(i|we)\s+(promise|commit|guarantee|agree|accept|confirm)\b|\b(deal|agreed|confirmed|you have my word)\b/iu;
const MONEY = /([$€£]\s?\d)|(\d[\d\s.,]*\s?(k|m)?\s?(eur|usd|gbp|chf|euros?|dollars?)\b)/iu;

export function detectCommitment(text: string): string[] {
  const found: string[] = [];
  if (PROMISE.test(text)) found.push("promise or acceptance");
  if (MONEY.test(text)) found.push("amount of money");
  return found;
}

/**
 * Runs on the drafted answer before it leaves. `topic` is declared by the answering AI,
 * so it only ever tightens the decision: hard limits apply regardless of the topic.
 */
export function postcheck(rules: Rules, sender: Sender, topic: string, answer: string): Decision {
  const leaked = rules.hardLimits.neverShare.filter((p) => new RegExp(p.pattern, "iu").test(answer));
  if (leaked.length > 0) {
    return { action: "refuse", reasons: leaked.map((p) => `hard limit: ${p.reason}`) };
  }

  const pre = precheck(rules, sender, 0);
  if (pre.action === "refuse") return pre;

  const reasons = [...pre.reasons];
  const rule = rules.topics.find((t) => t.name.toLowerCase() === topic.trim().toLowerCase());
  let action: Action = rule?.action ?? rules.defaultAction;
  if (!rule) reasons.push(`unlisted topic "${topic}"`);

  if (action === "refuse") return { action, reasons: [...reasons, `topic "${rule?.name ?? topic}" is refused`] };

  if (action === "answer" && rule?.trust && (sender.trust === "unknown" || !rule.trust.includes(sender.trust))) {
    action = "ask";
    reasons.push(`trust "${sender.trust}" not auto-answered for "${rule.name}"`);
  }
  if (pre.action === "ask") action = "ask";

  if (rules.hardLimits.askBeforeCommitting) {
    const commitments = detectCommitment(answer);
    if (commitments.length > 0) {
      action = "ask";
      reasons.push(...commitments.map((c) => `commitment: ${c}`));
    }
  }
  if (action === "ask" && rule?.action === "ask") reasons.push(`topic "${rule.name}" requires approval`);
  return { action, reasons };
}
