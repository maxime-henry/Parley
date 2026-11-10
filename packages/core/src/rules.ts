import { parse } from "yaml";
import { z } from "zod";

export const TRUST_LEVELS = ["trusted", "teammate", "known", "blocked"] as const;
export const Trust = z.enum(TRUST_LEVELS);
export type Trust = z.infer<typeof Trust>;

export const Action = z.enum(["answer", "ask", "refuse"]);
export type Action = z.infer<typeof Action>;

const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const Handle = z.string().regex(HANDLE, "handle: 2-32 chars, a-z 0-9 _ -");
export const isValidHandle = (handle: string) => HANDLE.test(handle);

const Pattern = z.object({
  pattern: z.string().refine((p) => {
    try {
      new RegExp(p, "iu");
      return true;
    } catch {
      return false;
    }
  }, "invalid regular expression"),
  reason: z.string().min(1),
});

export const RulesSchema = z.object({
  unknownContacts: z.enum(["refuse", "ask"]).default("ask"),
  maxQuestionsPerDay: z.number().int().positive().default(30),
  defaultAction: Action.default("ask"),
  contacts: z
    .array(
      z.object({
        handle: Handle,
        trust: Trust,
        maxQuestionsPerDay: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  topics: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().default(""),
        action: Action,
        // Trust levels allowed an automatic answer; others are escalated to the owner.
        trust: z.array(Trust).optional(),
      }),
    )
    .default([]),
  hardLimits: z
    .object({
      neverShare: z.array(Pattern).default([]),
      askBeforeCommitting: z.boolean().default(true),
    })
    .prefault({}),
});

export type Rules = z.infer<typeof RulesSchema>;

export function parseRules(yamlText: string): Rules {
  return RulesSchema.parse(parse(yamlText) ?? {});
}

export const DEFAULT_RULES_YAML = `# Parley sharing rules. Hard limits are enforced in code, not by the LLM.
unknownContacts: ask        # refuse | ask
maxQuestionsPerDay: 30      # per contact
defaultAction: ask          # answer | ask | refuse, for topics not listed below

contacts: []
#  - handle: alice
#    trust: teammate        # trusted | teammate | known | blocked

topics:
  - name: technical
    description: Questions about my code, repositories, APIs, docs and public issues.
    action: answer
    trust: [trusted, teammate]
  - name: scheduling
    description: Availability, meetings, deadlines.
    action: ask
  - name: personal
    description: Health, family, finances, HR matters.
    action: refuse

hardLimits:
  askBeforeCommitting: true
  neverShare:
    - pattern: "(api[_-]?key|secret|password|passwd|token)\\\\s*[:=]"
      reason: credentials
    - pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----"
      reason: private key
`;
