import type { User } from "./store.ts";

export type Notification = { title: string; body: string; url?: string };

export interface Notifier {
  notify(user: User, n: Notification): Promise<void>;
}

/** Console for local dev, plus ntfy when the user has a topic. Email (SES) comes next. */
export class DefaultNotifier implements Notifier {
  private readonly ntfyBaseUrl: string;

  constructor(ntfyBaseUrl = process.env.NTFY_URL ?? "https://ntfy.sh") {
    this.ntfyBaseUrl = ntfyBaseUrl;
  }

  async notify(user: User, n: Notification): Promise<void> {
    console.log(`[notify @${user.handle}] ${n.title}: ${n.body}${n.url ? `\n  -> ${n.url}` : ""}`);
    if (!user.ntfyTopic) return;
    try {
      const res = await fetch(`${this.ntfyBaseUrl}/${encodeURIComponent(user.ntfyTopic)}`, {
        method: "POST",
        body: n.body,
        headers: { Title: n.title, Tags: "speech_balloon", ...(n.url ? { Click: n.url } : {}) },
      });
      if (!res.ok) console.error(`ntfy returned ${res.status} for @${user.handle}`);
    } catch (err) {
      console.error(`ntfy failed for @${user.handle}:`, err);
    }
  }
}
