import { TELEMETRY_DATA_COLLECTION, scrubTelemetryEvent } from "@ago/shared/redaction";

/**
 * Sentry options shared by the server and browser SDKs (AGO-104). Client-safe: it imports only the
 * `@ago/shared/redaction` subpath, never the server env schema.
 *
 * Free-plan safe by construction: no tracing, no Replay, no profiling, no PII. Every event and
 * breadcrumb passes through the shared redactor before it leaves the process or the browser.
 */
export function buildSentryOptions(dsn: string, environment: string) {
  return {
    dsn,
    environment,
    // Sentry v11 has no `sendDefaultPii`; `dataCollection` is the PII switch and defaults to on.
    dataCollection: TELEMETRY_DATA_COLLECTION,
    tracesSampleRate: 0,
    beforeSend: <T extends object>(event: T): T => scrubTelemetryEvent(event),
    beforeBreadcrumb: <T extends object>(breadcrumb: T): T => scrubTelemetryEvent(breadcrumb),
  };
}
