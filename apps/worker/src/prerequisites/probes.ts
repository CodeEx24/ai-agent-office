import type { PrerequisiteName } from "@ago/shared";

import { approvalPayloadHash } from "../approvals/payload-hash.js";
import { BrokerDeniedError, createCredentialBroker } from "../credentials/credential-broker.js";
import { createInMemorySecretStore } from "../credentials/secret-store.js";
import { DENY_ALL_EGRESS, createFileEgressAllowlistProvider } from "../egress/allowlist-config.js";
import { EGRESS_PROXY_IMAGE, buildProxyRunArgs } from "../egress/egress-launcher.js";
import { buildDockerRunArgs } from "../sandbox/docker-runner.js";
import { SANDBOX_IMAGE, resolveSandboxLimits } from "../sandbox/sandbox-runner.js";

import type { CredentialVerifier } from "../identity/index.js";

/**
 * Probes for the four capability prerequisites (AGO-85). Each one exercises the real builder or guard with
 * safe inputs and no Docker: it checks the behaviour the capability relies on, not a flag. A probe returns
 * `undefined` when the prerequisite holds, or a short fixed reason code when it does not. It never returns
 * text taken from an error, a path or a value.
 */
export type ProbeOutcome = string | undefined;

export interface PrerequisiteProbe {
  readonly name: PrerequisiteName;
  run(): ProbeOutcome | Promise<ProbeOutcome>;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The first hardening flag a `docker run` argument list is missing, or undefined when all are present. */
export function findHardeningGap(
  args: readonly string[],
  options: { readonly expectedImage: string },
): string | undefined {
  const joined = args.join(" ");
  if (args.includes("--privileged")) return "privileged";
  if (!args.includes("--read-only")) return "not_read_only";
  if (flagValue(args, "--cap-drop") !== "ALL") return "caps_not_dropped";
  if (!args.includes("no-new-privileges")) return "new_privileges_allowed";
  if (/unconfined/i.test(joined)) return "unconfined_profile";
  if (args.includes("-v") || args.includes("--volume") || args.includes("--mount"))
    return "host_mount";
  if (joined.includes("docker.sock")) return "docker_socket";
  if (flagValue(args, "--ipc") === "host" || flagValue(args, "--pid") === "host")
    return "host_namespace";
  const user = flagValue(args, "--user");
  if (user === undefined || user === "0" || user.startsWith("0:") || user === "root")
    return "runs_as_root";
  const image = args.find((a) => a === options.expectedImage);
  if (image === undefined || !/@sha256:[0-9a-f]{64}$/.test(image)) return "image_not_pinned";
  return undefined;
}

export const sandboxProbe: PrerequisiteProbe = {
  name: "sandbox_hardened",
  run() {
    const args = buildDockerRunArgs({
      name: "prereq-probe",
      runId: "prereq-probe",
      image: SANDBOX_IMAGE,
      limits: resolveSandboxLimits(),
      command: ["true"],
      hasFiles: false,
    });
    const gap = findHardeningGap(args, { expectedImage: SANDBOX_IMAGE });
    if (gap !== undefined) return gap;
    if (flagValue(args, "--network") !== "none") return "network_not_none";
    const envEntries = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
    if (envEntries.some((entry) => !entry.startsWith("HOME="))) return "environment_leaked";
    if (flagValue(args, "--memory") === undefined || flagValue(args, "--pids-limit") === undefined)
      return "no_resource_limits";
    return undefined;
  },
};

export const egressProbe: PrerequisiteProbe = {
  name: "egress_default_deny",
  async run() {
    const workspace = "00000000-0000-4000-8000-000000000001";
    const denies = (allowlist: { hosts: readonly string[]; ports: readonly number[] }): boolean =>
      allowlist.hosts.length === 0 && allowlist.ports.length === 0;
    const quiet = (): void => undefined;
    const fromText = (text: string | Error, path: string | undefined) =>
      createFileEgressAllowlistProvider({
        path,
        warn: quiet,
        readText: () => (text instanceof Error ? Promise.reject(text) : Promise.resolve(text)),
      }).forWorkspace(workspace);

    if (!denies(await fromText("{}", undefined))) return "unconfigured_not_denied";
    if (!denies(await fromText(new Error("x"), "allowlist.json"))) return "unreadable_not_denied";
    if (!denies(await fromText("not json", "allowlist.json"))) return "malformed_not_denied";
    const wildcard = JSON.stringify({
      version: 1,
      workspaces: { [workspace]: { hosts: ["*"], ports: [443] } },
    });
    if (!denies(await fromText(wildcard, "allowlist.json"))) return "wildcard_allowed";
    if (!denies(DENY_ALL_EGRESS)) return "deny_all_not_empty";

    const proxyArgs = buildProxyRunArgs({
      name: "prereq-probe",
      networkName: "prereq-probe",
      image: EGRESS_PROXY_IMAGE,
      runId: "prereq-probe",
      workspaceId: workspace,
      allowlist: DENY_ALL_EGRESS,
    });
    return findHardeningGap(proxyArgs, { expectedImage: EGRESS_PROXY_IMAGE });
  },
};

/** A verifier that refuses everything: the probe must be denied without ever reaching a secret. */
const refusingVerifier: CredentialVerifier = {
  verify: () => Promise.resolve({ ok: false, reason: "malformed" }),
};

export const brokerProbe: PrerequisiteProbe = {
  name: "credential_broker",
  async run() {
    // Built at run time so no secret-looking literal sits in the source.
    const fakeValue = ["probe", "value", String(Date.now())].join("-");
    const state = { wasSecretUsed: false };
    const broker = createCredentialBroker({
      verifier: refusingVerifier,
      secrets: createInMemorySecretStore([
        { workspaceId: "w", name: "probe_key", value: fakeValue, capabilities: ["code.run"] },
      ]),
    });
    const attempt = async (secretRef: string, token: string | undefined): Promise<string> => {
      try {
        await broker.withSecret(
          {
            workspaceId: "w",
            agentId: "a",
            runId: "r",
            toolName: "probe",
            capability: "code.run",
            secretRef,
            credentialToken: token,
          },
          () => {
            state.wasSecretUsed = true;
            return Promise.resolve("ran");
          },
        );
        return "allowed";
      } catch (error) {
        return error instanceof BrokerDeniedError ? error.reason : "error";
      }
    };
    if ((await attempt(fakeValue, "token")) !== "invalid_reference") return "raw_secret_accepted";
    if ((await attempt("secret:probe_key", undefined)) !== "no_credential")
      return "missing_credential_accepted";
    if ((await attempt("secret:probe_key", "token")) !== "malformed")
      return "bad_credential_accepted";
    return state.wasSecretUsed ? "secret_released" : undefined;
  },
};

export const approvalProbe: PrerequisiteProbe = {
  name: "approval_payload_hash",
  run() {
    const hash = approvalPayloadHash("probe_tool", { b: 1, a: { d: 2, c: 3 } });
    if (!/^[0-9a-f]{64}$/.test(hash)) return "hash_not_sha256";
    if (hash !== approvalPayloadHash("probe_tool", { a: { c: 3, d: 2 }, b: 1 }))
      return "hash_not_canonical";
    if (hash === approvalPayloadHash("probe_tool", { a: { c: 3, d: 2 }, b: 2 }))
      return "input_change_not_bound";
    if (hash === approvalPayloadHash("other_tool", { a: { c: 3, d: 2 }, b: 1 }))
      return "tool_change_not_bound";
    return undefined;
  },
};

export const DEFAULT_PREREQUISITE_PROBES: readonly PrerequisiteProbe[] = [
  sandboxProbe,
  egressProbe,
  brokerProbe,
  approvalProbe,
];
