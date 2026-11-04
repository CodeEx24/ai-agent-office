import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** True when the shared local Supabase stack is available (set E2E_SUPABASE=1). */
export const isLiveStack = process.env.E2E_SUPABASE === "1";

/** Local mail catcher (Mailpit) from supabase/config.toml: http://127.0.0.1:55424. */
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:55424";

/** Saved session for specs that start signed in. Git-ignored; written by auth.setup.ts. */
export const AUTH_STATE_PATH = fileURLToPath(new URL("../.auth/user.json", import.meta.url));

/** A unique address per test, so parallel specs never read each other's mail. */
export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.test`;
}

interface MailpitSearch {
  messages?: { ID: string }[];
}

interface MailpitMessage {
  Text: string;
  HTML: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path} returned ${String(response.status)}`);
  return (await response.json()) as T;
}

/** Waits for the newest message to `email`, polling the mail catcher (no fixed sleeps). */
export async function waitForEmail(email: string, timeoutMs = 15_000): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = await fetchJson<MailpitSearch>(
      `/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const id = search.messages?.[0]?.ID;
    if (id) return fetchJson<MailpitMessage>(`/api/v1/message/${id}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No email arrived for ${email} within ${String(timeoutMs)}ms`);
}

export async function fetchSignInCode(email: string): Promise<string> {
  const message = await waitForEmail(email);
  const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
  if (!code) throw new Error("The sign-in email has no 6-digit code");
  return code;
}

export async function fetchMagicLink(email: string): Promise<string> {
  const message = await waitForEmail(email);
  const href = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(message.HTML)?.[1];
  if (!href) throw new Error("The sign-in email has no magic link");
  return href.replaceAll("&amp;", "&");
}
