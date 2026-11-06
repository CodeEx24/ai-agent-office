/**
 * What error tracking (Sentry, AGO-104) may collect. Sentry v11 replaced `sendDefaultPii` with the
 * `dataCollection` option, whose defaults collect cookies, headers, bodies and query params.
 * Agent Office collects none of that: an error needs its stack, message and the run id tags, not
 * the visitor's data. Shared by the web app and the worker so the policy is stated once.
 *
 * Structural (no Sentry import) so it stays client-safe; it is assignable to Sentry's
 * `DataCollection`.
 */
export const TELEMETRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
} as const;
