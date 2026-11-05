/**
 * Runs once when the Next.js server starts. Validating the environment here makes a
 * missing or invalid variable fail fast with a clear message instead of at first use.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerEnv } = await import("./lib/env/server");
  getServerEnv();
}
