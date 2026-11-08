# Parley

Open-source delegate agents that talk to each other on your behalf. Built on [A2A](https://a2a-protocol.org) and [MCP](https://modelcontextprotocol.io): your AI asks, informs and coordinates with other people's AIs, following your sharing rules, and only interrupts you when it matters.

> **Status:** early design. Nothing is built yet. This README is the plan, and we welcome feedback on it.

---

## The problem

More and more of our messages are written by AI and read by AI:

1. Alice asks her AI to write a question to Bob.
2. Bob pastes the email into his AI, which digs through his notes and documents and writes a reply.
3. Bob copies the reply back into an email.
4. Alice pastes it into her AI to make sense of it.

Two machines are talking, with two humans acting as slow, expensive copy-paste relays in between.

## The idea

**Let the AIs talk directly.**

With Parley, Alice's agent asks Bob's agent. Bob's agent answers from what Bob's AI already knows, within the rules Bob set, **without asking Bob first**. Bob only hears about it when it matters: his agent doesn't know the answer, a rule says "ask me", or the answer would commit him to something.

Both sides keep a full, readable log of every exchange.

```mermaid
sequenceDiagram
    participant A as Alice
    participant AA as Alice's agent
    participant BA as Bob's agent
    participant B as Bob
    A->>AA: "Ask Bob when the v2 contract ends"
    AA->>BA: Question (A2A)
    BA->>BA: Check Bob's sharing rules + context
    alt Allowed and known
        BA->>AA: Answer
    else Unknown, sensitive or a commitment
        BA->>B: Interrupt: "Alice asks… OK to answer?"
        B->>BA: Decision
        BA->>AA: Answer (or polite refusal)
    end
    AA->>A: "The contract ends on March 31"
```

### What if the other person doesn't use Parley?

They get an email containing the question and a link. They can answer on a simple web page, by hand or with their own AI, and sign up from there if they want their own agent. Parley is useful from the first user, and every question sent invites one more.

## Principles

- **Your AI, your model.** Parley works with any LLM. It plugs into the assistant you already use instead of replacing it.
- **Autonomous by default, accountable always.** Agents answer on their own from day one, and every exchange is logged and reviewable.
- **Sharing rules come first.** You decide what your agent may share, with whom and on which topics. Hard limits are enforced in code, not left to the LLM's judgement.
- **Messages from other agents are untrusted input.** An incoming question is data, never instructions. Defending against prompt injection is a core feature, not an afterthought.
- **Open protocols.** A2A between agents, MCP between Parley and your AI. No lock-in: anyone can run a compatible agent.
- **Open source, with a hosted service.** Use the hosted service at parley (domain to come), or run it yourself.

## Key concepts

| Concept | What it is |
| --- | --- |
| **Agent** | Your delegate. It speaks for you to other agents. |
| **Contact** | Another person's agent, with a trust level you set. |
| **Thread** | One conversation between two (later, several) agents: questions, answers, follow-ups. |
| **Sharing rules** | What your agent may share, with whom and on which topics. Written in plain language, plus a few hard limits ("never share my health data", "never accept a meeting before 9am"). |
| **Interruption** | The moment your agent stops and asks you, because it lacks information, a rule requires it, or it would commit you to something (a date, a price, a promise). |

## Roadmap

### Phase 0: Foundations
- [ ] Message format for threads, questions, answers and interruptions, mapped onto A2A tasks and messages
- [ ] Sharing rules format (plain language + hard limits)
- [ ] Threat model: prompt injection, data leaks, impersonation
- [ ] Choose an identity approach (see [Open questions](#open-questions))

### Phase 1: Parley as an MCP server (v0.1, individuals)
Parley is an MCP server you add to your existing AI (Claude, ChatGPT, Cursor, …). The hosted service holds each user's inbox and outbox and relays messages between agents.
- [ ] MCP tools: `ask_contact`, `check_inbox`, `answer`, `escalate_to_me`, `set_sharing_rules`, `list_threads`
- [ ] Hosted relay: accounts, contacts, threads, inbox and outbox
- [ ] Agent-to-agent delivery between Parley users over A2A
- [ ] Email bridge: questions to people without Parley, with a web answer page
- [ ] Your AI answers incoming questions on its own whenever it runs, including on a schedule where your client supports scheduled tasks
- [ ] Interruptions by email
- [ ] Readable log of every thread

**Limitation:** in this phase, answers go out only when your AI is running. Phase 2 removes that limit.

### Phase 2: Always-on hosted agent (individuals)
Parley runs your agent itself, so it can answer any time, even when you're offline.
- [ ] Bring your own LLM (API key, any provider)
- [ ] Connect your MCP sources (calendar, email, docs, notes…) so your agent knows what your AI knows
- [ ] Answers 24/7 within your sharing rules
- [ ] Interruptions via push notifications and chat apps (Slack, Telegram…)
- [ ] Interoperability with any A2A-compatible agent, not just Parley ones

### Phase 3: Small teams
- [ ] Team-wide sharing rules and a shared team agent ("ask the team")
- [ ] Multi-party threads, e.g. finding a meeting slot across 5 people
- [ ] Routing a question to the teammate whose agent knows the answer

### Phase 4: Companies
- [ ] Single sign-on (SSO), admin console, organisation-wide rules
- [ ] Audit trail, data retention and compliance controls
- [ ] Self-hosting guide for on-premises deployments

## Decisions so far

| Topic | Decision | Status |
| --- | --- | --- |
| Target users | Individuals and small teams first, companies later | ✅ Confirmed |
| Distribution | Hosted service (open-source, self-hostable) | ✅ Confirmed |
| LLM | Any LLM | ✅ Confirmed |
| Architecture | MCP server first (Phase 1), hosted agent next (Phase 2) | ✅ Confirmed |
| Non-Parley contacts | Email bridge with a web answer page | ✅ Confirmed |
| Autonomy | Answers on its own from day one | ✅ Confirmed |
| First use case | Asking and answering questions (replacing AI-written email ping-pong) | 💡 Proposed |
| Sharing rules | Plain language + hard limits enforced in code | 💡 Proposed |
| Interruption channel | Email first, then push and chat apps | 💡 Proposed |
| Stack | TypeScript (mature MCP and A2A SDKs), PostgreSQL | 💡 Proposed |

## Open questions

- **Identity and trust.** How does an agent prove it speaks for its owner, and how do you know who is asking? Candidates: signed A2A Agent Cards, OAuth/OpenID Connect, verified email or domain, public keys exchanged as contacts.
- **Licence.** The project is currently under Apache-2.0, which is easy to adopt for the protocol and SDKs. However, a hosted service can be forked and run closed by others. One option is to keep the spec and SDKs under Apache-2.0 and put the server under AGPL-3.0. Undecided.
- **Liability.** If an agent answers something wrong on your behalf, how do we make it clear the message came from an agent, and how do you correct it afterwards?
- **Abuse.** How do we stop spam and agents being used to extract information? Possible answers: rate limits, contact approval, reputation.

## Contributing

The project is at the design stage: the most useful contribution right now is feedback on this plan. Open an issue with your questions, use cases and objections.

## License

[Apache-2.0](LICENSE) (see the licence question under [Open questions](#open-questions)).
