import { prerequisiteResultSchema, type PrerequisiteResult } from "@ago/shared";
import { z } from "zod";

/** The worker answers in milliseconds; anything slower than this is a deny (timeout means deny). */
export const PREREQUISITE_REPORT_TIMEOUT_MS = 2_000;

/** Strict: an extra field (a path, a host, an env value, a stack) makes the whole report invalid. */
const reportSchema = z.strictObject({ results: z.array(prerequisiteResultSchema).max(16) });

const workerUrlSchema = z.url({ protocol: /^https?$/ });

export interface PrerequisiteReportOptions {
  /** Defaults to `WORKER_INTERNAL_URL`. Unset or invalid means there is no report. */
  readonly workerUrl?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * Reads the worker's prerequisite report (AGO-85), server side only. It never throws and never returns a
 * partial or unvalidated report: when `WORKER_INTERNAL_URL` is unset or invalid, the worker is down, answers
 * late, answers with anything but 200 JSON of the exact shape, the result is an empty report, and the evaluator
 * treats every prerequisite nobody reported as failed. The caller's flag is never part of this.
 */
export async function fetchPrerequisiteReport(
  options: PrerequisiteReportOptions = {},
): Promise<PrerequisiteResult[]> {
  const rawUrl = "workerUrl" in options ? options.workerUrl : process.env.WORKER_INTERNAL_URL;
  const url = workerUrlSchema.safeParse(rawUrl);
  if (!url.success) return [];
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    Math.min(options.timeoutMs ?? PREREQUISITE_REPORT_TIMEOUT_MS, PREREQUISITE_REPORT_TIMEOUT_MS),
  );
  try {
    const response = await fetchFn(new URL("/prerequisites", url.data), {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) return [];
    const body: unknown = await response.json();
    const parsed = reportSchema.safeParse(body);
    return parsed.success ? parsed.data.results : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
