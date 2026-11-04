import { z } from "zod";

// Small typed env helper for the public Supabase settings. AGO-70 (validated env config, PR #10)
// will replace it; keep every read behind getSupabasePublicEnv() so that switch is one file.
//
// The values are read from a `process.env` alias on purpose. A literal `process.env.NEXT_PUBLIC_*`
// would be inlined at `next build`, which freezes whatever the build shell had. Reading at request
// time lets the same build run against any Supabase URL. Only the URL and the anon key are public;
// no service-role or provider secret is ever read here.
const supabasePublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

/** Public origin of this app (used to build auth redirect URLs). Never derived from request headers. */
export function getAppUrl(): string {
  const raw = process.env;
  return z
    .url()
    .parse(raw.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000")
    .replace(/\/$/, "");
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const source = process.env;
  const parsed = supabasePublicEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return { url: parsed.NEXT_PUBLIC_SUPABASE_URL, anonKey: parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}
