import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * AGO-51: timeout means deny, kept true by a static check.
 *
 * No code path may turn a pending or expired approval into an approved one without a human decision. This test
 * scans the source (TypeScript and SQL, including `supabase/migrations`) for the shapes such a path would take:
 *
 *   R1  a write of `approved` to a `status` (object property, shorthand, assignment), or a setter call whose name is a
 *       write verb then Status, Decision or Outcome (`setStatus(id, "approved")`). The value may come through a
 *       constant, a pure alias (`const s = APPROVAL_STATUS`, an import alias, `APPROVAL_STATUS.approved`), a `+`
 *       concatenation or a ternary;
 *   R2  a timeout/expiry handler (by function name, or by an `if` / `?:` on an expiry condition) that resolves to
 *       allow, approved or proceed, or runs the call; and a decision event that is `approved` and `timeout`-decided;
 *   R3  SQL that sets a status to `approved`: UPDATE ... SET, `new.status = ` starting a statement, `new.status :=`,
 *       INSERT. It is found in a `.sql` file or in a string in TypeScript (also a `+` concatenation). A `$n` parameter
 *       bound to `approved`, a SQL `||` join and a plpgsql variable bound to `approved` all count. Comparisons are not
 *       writes: `where status = 'approved'`, `if new.status = 'approved'`, `case when status = 'approved'`, a trigger
 *       `when (...)` clause.
 *
 * The only place that may write `approved` is a human decide route (AGO-58). It must be listed in
 * `HUMAN_DECISION_FILES` below, which makes the exception visible in review.
 *
 * It is a tripwire, not a proof. It follows values inside one file only. It does not follow computed keys, object or
 * array indirection (`S.ok`, `["approved"][0]`), values from another module, runtime-built strings (`.join`,
 * `.toLowerCase()`, a function's return value, row data), dynamic SQL (`execute format(...)`), a name reused in another
 * function (name shadowing), a reassignment that is not flow-checked, or an INSERT with a `$n` bound to approved. The
 * list of misses is in docs/features/approvals.md and docs/tickets/AGO-51.md under "Known limitations", and the two
 * must match. Review is the backstop for those. The runtime
 * guarantees (the conditional `expire` and `consume` SQL, the RLS policy, the loop's refusal codes) are the real
 * enforcement.
 */

type RuleId = "R1-status-write" | "R2-timeout-allows" | "R3-sql-approve";

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: RuleId;
  readonly snippet: string;
}

/** Repo-relative POSIX paths of the human-only decide routes that may write `approved`. Empty until AGO-58. */
const HUMAN_DECISION_FILES: readonly string[] = [];

const EXPIRY_WORD = /(expir|timeout|timed_?out|ttl|deadline|sweep|lapse)/i;
const ALLOW_WORDS: ReadonlySet<string> = new Set([
  "allow",
  "allowed",
  "approve",
  "approved",
  "proceed",
  "granted",
  "grant",
]);
const ALLOW_FLAGS: ReadonlySet<string> = new Set([
  "approved",
  "granted",
  "allow",
  "allowed",
  "proceed",
]);
const ALLOW_CALL = /^(approve|grant|allow|proceed|execute|run)\w*$/i;
/** A setter for a status, decision or outcome: `setStatus`, `updateDecision`, `markOutcome`, ... */
const SETTER =
  /^(set|update|mark|save|write|change|transition|record)\w*(Status|Decision|Outcome)$/;
const SYSTEM_ACTOR = /^(timeout|system|sweeper|sweep|expiry|expired|timer|cron)$/i;
const STATUS_HOLDER = /(status|outcome|decision)/i;
const UNKNOWN = "\u0000";

const isApproved = (value: string): boolean => value.toLowerCase() === "approved";

// ---------------------------------------------------------------------------------------------- values

type Env = ReadonlyMap<string, ts.Node>;

function collectEnv(source: ts.SourceFile): Env {
  const env = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      env.set(node.name.text, node.initializer);
    }
    // `import { APPROVAL_STATUS as A }` binds A to the status holder.
    if (ts.isImportSpecifier(node) && STATUS_HOLDER.test((node.propertyName ?? node.name).text)) {
      env.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return env;
}

/**
 * True for `APPROVAL_STATUS`, for a name that says status, and for a pure alias of one (`const s = APPROVAL_STATUS`,
 * an import alias). An alias counts only when its initializer is a bare identifier, a property access or an import,
 * so `const counts = countByStatus(...)` is not a holder.
 */
const MAX_ALIAS_HOPS = 8;

function isStatusHolder(expression: ts.Expression, env: Env, depth = 0): boolean {
  if (STATUS_HOLDER.test(expression.getText())) return true;
  if (!ts.isIdentifier(expression) || depth >= MAX_ALIAS_HOPS) return false;
  const bound = env.get(expression.text);
  if (bound === undefined) return false;
  // A chain of pure aliases (`const a = APPROVAL_STATUS; const b = a;`) is followed hop by hop.
  if (ts.isIdentifier(bound)) return isStatusHolder(bound, env, depth + 1);
  const isPure = ts.isPropertyAccessExpression(bound) || ts.isImportSpecifier(bound);
  return isPure && STATUS_HOLDER.test(bound.getText());
}

/**
 * Every string an expression can evaluate to, following constants, `+`, templates, ternaries and
 * `APPROVAL_STATUS.x` style lookups. `unknownAs` stands in for a part that cannot be resolved; without it an
 * unresolvable expression yields no values (the scan never guesses).
 */
function valuesOf(
  node: ts.Node,
  env: Env,
  unknownAs?: string,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const unknown = unknownAs === undefined ? [] : [unknownAs];
  const recurse = (child: ts.Node) => valuesOf(child, env, unknownAs, seen);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return recurse(node.expression);
  }
  if (ts.isConditionalExpression(node))
    return [...recurse(node.whenTrue), ...recurse(node.whenFalse)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = recurse(node.left);
    const right = recurse(node.right);
    return left.flatMap((l) => right.map((r) => l + r));
  }
  if (ts.isTemplateExpression(node)) {
    let parts: string[] = [node.head.text];
    for (const span of node.templateSpans) {
      const inner = recurse(span.expression);
      const options = inner.length > 0 ? inner : unknown;
      parts = parts.flatMap((p) => options.map((o) => p + o + span.literal.text));
    }
    return parts;
  }
  if (ts.isIdentifier(node)) {
    const init = env.get(node.text);
    if (init === undefined || seen.has(node.text)) return unknown;
    return valuesOf(init, env, unknownAs, new Set([...seen, node.text]));
  }
  if (ts.isPropertyAccessExpression(node) && isStatusHolder(node.expression, env)) {
    // APPROVAL_STATUS.approved, ApprovalStatus.approved, or an alias of it: the member name is the value.
    return [node.name.text];
  }
  return unknown;
}

// ------------------------------------------------------------------------------------------------- SQL

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Lower-cased, comment-free, single-spaced SQL with adjacent string literals joined (`'appro' || 'ved'`). */
function normalizeSql(raw: string): string {
  let joined = stripSqlComments(raw).replace(/\s+/g, " ").toLowerCase();
  let previous = "";
  while (joined !== previous) {
    previous = joined;
    joined = joined.replace(/'([^']*)'\s*\|\|\s*'([^']*)'/g, "'$1$2'");
  }
  return joined;
}

/**
 * plpgsql variables bound in this text. `v_status := 'approved';` binds v_status. So do the declared forms
 * `declare v text := 'approved';` and `v text default 'approved';`, with an optional type after the name. The
 * declared forms run first, so a later `:=` for the same name wins (flow-insensitive: one value per name).
 */
const DECLARED_DEFAULT =
  /(?<![.\w])(\w+)\s+(?:\w+(?:\s*\([^)]*\))?\s+)?(?::=|default\s)\s*([^;]*)/g;
const ASSIGNED = /(?<![.\w])(\w+)\s*:=\s*([^;]*)/g;

function sqlVariables(normalized: string): ReadonlyMap<string, string> {
  const vars = new Map<string, string>();
  for (const match of normalized.matchAll(DECLARED_DEFAULT)) {
    vars.set(match[1] ?? "", match[2] ?? "");
  }
  for (const match of normalized.matchAll(ASSIGNED)) {
    vars.set(match[1] ?? "", match[2] ?? "");
  }
  return vars;
}

/** Drops a trailing cast (`v::text`) and the parentheses around a bare name (`(v)`). */
function unwrapSqlValue(expression: string): string {
  const uncast = expression
    .trim()
    .replace(/::\s*[\w\s[\]]+$/, "")
    .trim();
  return uncast.replace(/^\(\s*(\w+)\s*\)$/, "$1");
}

/** Split on top-level commas (not inside parentheses or quotes). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let current = "";
  for (const ch of text) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === "(") depth += 1;
    if (!quote && ch === ")") depth -= 1;
    if (!quote && depth === 0 && ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * True when a value written to a status is `'approved'`. An occurrence that is the operand of a comparison
 * (`status = 'approved'`, `'approved' <> status`, `in ('approved', ...)`) is not a write, and neither is `:=` on its
 * left (that is an assignment).
 */
function writesApproved(expression: string): boolean {
  for (const match of expression.matchAll(/'approved'/g)) {
    const at = match.index;
    const before = expression.slice(0, at).trimEnd();
    const after = expression.slice(at + "'approved'".length).trimStart();
    const comparedBefore = /(?:(?<!:)=|<>|!=)$/.test(before) || /\bin\s*\([^()]*$/.test(before);
    const comparedAfter = /^(?:=|<>|!=)/.test(after);
    if (!comparedBefore && !comparedAfter) return true;
  }
  return false;
}

/**
 * Snippets of SQL that set a status to `approved`. `params[n-1]` lists the values a `$n` may take. `vars` binds
 * plpgsql variables for the whole text; it defaults to the variables of `rawSql` itself.
 */
function sqlApproves(
  rawSql: string,
  params: readonly (readonly string[])[] = [],
  vars?: ReadonlyMap<string, string>,
): string[] {
  const sql = normalizeSql(rawSql);
  const bindings = vars ?? sqlVariables(sql);
  // Follows a variable to its value, and a chain of variables (`b := a;`) hop by hop.
  const valueOf = (expression: string, depth = 0): string => {
    const trimmed = unwrapSqlValue(expression);
    const bound = bindings.get(trimmed);
    return bound !== undefined && depth < MAX_ALIAS_HOPS ? valueOf(bound, depth + 1) : trimmed;
  };
  const hits: string[] = [];
  for (const match of sql.matchAll(/\bset ([^;]*)/g)) {
    const clause = (match[1] ?? "").split(/ (?:where|returning|from) /)[0] ?? "";
    for (const assignment of splitTopLevel(clause)) {
      const target = /^\s*(?:\w+\.)?status\s*=\s*(.*)$/.exec(assignment);
      if (target === null) continue;
      const expression = target[1] ?? "";
      const bound = /^\$(\d+)\b/.exec(expression.trim());
      const boundValues = bound === null ? [] : (params[Number(bound[1]) - 1] ?? []);
      if (writesApproved(valueOf(expression)) || boundValues.some(isApproved)) {
        hits.push(`set ${assignment.trim()}`);
      }
    }
  }
  // `new.status = x` is an assignment only at the start of a statement. Elsewhere it is a comparison (`if`, `elsif`,
  // `when`, `where`, a trigger `when (...)`). `new.status := x` is always an assignment.
  const assignmentStart =
    /(?:(?:^|;|\bbegin|\bthen|\belse|\bloop)\s*new\.status\s*(=)|\bnew\.status\s*(:=))\s*([^;]*)/g;
  for (const match of sql.matchAll(assignmentStart)) {
    const operator = match[1] ?? match[2] ?? "=";
    const expression = match[3] ?? "";
    if (writesApproved(valueOf(expression)))
      hits.push(`new.status ${operator} ${expression.trim()}`);
  }
  for (const match of sql.matchAll(/\binsert into (?:\w+\.)?approvals\b[^;]*/g)) {
    if (match[0].includes("'approved'")) hits.push(match[0].slice(0, 80));
  }
  return hits;
}

function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function scanSql(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const stripped = stripSqlComments(text);
  // Variables come from the whole file, so a plpgsql variable set in one statement and written in a later one counts.
  const vars = sqlVariables(normalizeSql(stripped));
  // Report per statement-ish chunk so each hit carries a useful line.
  let offset = 0;
  for (const chunk of stripped.split(/(?<=;)/)) {
    for (const snippet of sqlApproves(chunk, [], vars)) {
      findings.push({
        file,
        line: lineOfOffset(stripped, offset),
        rule: "R3-sql-approve",
        snippet,
      });
    }
    offset += chunk.length;
  }
  return findings;
}

// ------------------------------------------------------------------------------------------ TypeScript

function propName(name: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function calleeName(call: ts.CallExpression): string {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return "";
}

type FunctionNode =
  ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function functionName(node: FunctionNode): string {
  if (!ts.isArrowFunction(node) && node.name) return node.name.getText();
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    return parent.name.getText();
  return "";
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

function scanTypeScript(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const env = collectEnv(source);
  const findings: Finding[] = [];
  const add = (node: ts.Node, rule: RuleId): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({
      file,
      line,
      rule,
      snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 100),
    });
  };
  const approvedValue = (node: ts.Node): boolean => valuesOf(node, env).some(isApproved);
  const allowValue = (node: ts.Node): boolean =>
    valuesOf(node, env).some((value) => ALLOW_WORDS.has(value.toLowerCase()));

  const inspectExpiryBranch = (branch: ts.Node): void => {
    walk(branch, (node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isPropertyAccessExpression(node)
      ) {
        if (allowValue(node)) add(node, "R2-timeout-allows");
      }
      if (ts.isPropertyAssignment(node)) {
        const name = propName(node.name);
        if (
          name !== undefined &&
          ALLOW_FLAGS.has(name) &&
          node.initializer.kind === ts.SyntaxKind.TrueKeyword
        ) {
          add(node, "R2-timeout-allows");
        }
      }
      if (ts.isCallExpression(node) && ALLOW_CALL.test(calleeName(node))) {
        add(node, "R2-timeout-allows");
      }
    });
  };

  walk(source, (node) => {
    // R1: status written as approved.
    if (
      ts.isPropertyAssignment(node) &&
      propName(node.name) === "status" &&
      approvedValue(node.initializer)
    ) {
      add(node, "R1-status-write");
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === "status" &&
      approvedValue(node.name)
    ) {
      add(node, "R1-status-write");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === "status") ||
        (ts.isElementAccessExpression(node.left) &&
          ts.isStringLiteralLike(node.left.argumentExpression) &&
          node.left.argumentExpression.text === "status")) &&
      approvedValue(node.right)
    ) {
      add(node, "R1-status-write");
    }
    // R1: a setter for a status, decision or outcome called with approved (`setStatus(id, "approved")`).
    if (
      ts.isCallExpression(node) &&
      SETTER.test(calleeName(node)) &&
      node.arguments.some(approvedValue)
    ) {
      add(node, "R1-status-write");
    }

    // R2: a decision that says approved and was made by the timeout.
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      const approvedOutcome = props.some(
        (p) => propName(p.name) === "outcome" && approvedValue(p.initializer),
      );
      const bySystem = props.some(
        (p) =>
          ["decided_by", "resumed_by", "decidedBy", "resumedBy"].includes(propName(p.name) ?? "") &&
          valuesOf(p.initializer, env).some((v) => SYSTEM_ACTOR.test(v)),
      );
      if (approvedOutcome && bySystem) add(node, "R2-timeout-allows");
    }

    // R2: expiry-named handlers, and branches on an expiry condition.
    if (isFunctionNode(node) && EXPIRY_WORD.test(functionName(node)) && node.body) {
      inspectExpiryBranch(node.body);
    }
    if (ts.isConditionalExpression(node) && EXPIRY_WORD.test(node.condition.getText(source))) {
      inspectExpiryBranch(node.whenTrue);
      inspectExpiryBranch(node.whenFalse);
    }
    if (ts.isIfStatement(node) && EXPIRY_WORD.test(node.expression.getText(source))) {
      inspectExpiryBranch(node.thenStatement);
      if (node.elseStatement) inspectExpiryBranch(node.elseStatement);
    }

    // R3: SQL in a string (alone, or the first argument of a call with a parameter array).
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const [sqlArg, paramsArg] = node.arguments;
      if (sqlArg !== undefined) {
        const params =
          paramsArg !== undefined && ts.isArrayLiteralExpression(paramsArg)
            ? paramsArg.elements.map((element) => valuesOf(element, env))
            : [];
        for (const sql of valuesOf(sqlArg, env, UNKNOWN)) {
          if (sqlApproves(sql, params).length > 0) add(sqlArg, "R3-sql-approve");
        }
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      for (const sql of valuesOf(node, env, UNKNOWN)) {
        if (sqlApproves(sql).length > 0) add(node, "R3-sql-approve");
      }
    }
    // R3: SQL built with `+` (the outermost `+` of a chain, so each built string is checked once).
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      for (const sql of valuesOf(node, env, UNKNOWN)) {
        if (sqlApproves(sql).length > 0) add(node, "R3-sql-approve");
      }
    }
  });

  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${String(f.line)}:${f.rule}:${f.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --------------------------------------------------------------------------------------------- driver

/** Scan one file's text. The extension picks the language; `.fixture` is ignored so fixtures keep their kind. */
function scanSource(file: string, text: string): Finding[] {
  const name = file.replace(/\.fixture$/, "");
  if (name.endsWith(".sql")) return scanSql(file, text);
  if (/\.(ts|tsx)$/.test(name)) return scanTypeScript(file, text);
  return [];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const SCAN_ROOTS = ["apps", "packages", join("supabase", "migrations")];
/**
 * Directories the real scan never enters. `__fixtures__` holds the planted violations this test plants on purpose.
 * `e2e` is Playwright test code (apps/web/e2e) that plays the human decider against a local database; it ships
 * nowhere.
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "__fixtures__",
  "e2e",
]);
const FIXTURE_DIR = join(HERE, "__fixtures__", "auto-approve");

function isScannedFile(name: string): boolean {
  if (/\.(test|spec)\.tsx?$/.test(name) || name.endsWith(".d.ts")) return false;
  return /\.(ts|tsx|sql)$/.test(name);
}

function listSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return EXCLUDED_DIRS.has(entry) ? [] : listSourceFiles(full);
    return isScannedFile(entry) ? [full] : [];
  });
}

const toRepoPath = (full: string): string => relative(REPO_ROOT, full).split(sep).join("/");

function scanRepo(): { files: string[]; findings: Finding[] } {
  const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)));
  const findings = files.flatMap((full) => {
    const path = toRepoPath(full);
    if (HUMAN_DECISION_FILES.includes(path)) return [];
    return scanSource(path, readFileSync(full, "utf8"));
  });
  return { files: files.map(toRepoPath), findings };
}

const fixture = (name: string): Finding[] =>
  scanSource(name, readFileSync(join(FIXTURE_DIR, name), "utf8"));
const rulesOf = (findings: readonly Finding[]): RuleId[] =>
  [...new Set(findings.map((f) => f.rule))].sort();
const describeFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.file}:${String(f.line)} [${f.rule}] ${f.snippet}`).join("\n");

describe("AGO-51 AC1: no code path approves on timeout", () => {
  it("finds none in apps/**, packages/** or supabase/migrations", () => {
    const { findings } = scanRepo();
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it("really scans: TypeScript, tsx and the migrations are in, the planted fixtures are out", () => {
    const { files } = scanRepo();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("apps/worker/src/approvals/approval-store.ts");
    expect(files).toContain("apps/worker/src/agent/agent-loop.ts");
    expect(files.some((f) => f.startsWith("supabase/migrations/") && f.endsWith(".sql"))).toBe(
      true,
    );
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.includes("__fixtures__"))).toBe(false);
    expect(files.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))).toBe(false);
    expect(files.some((f) => f.includes("/e2e/"))).toBe(false);
  });

  it("keeps the human-decision allowlist honest: existing files, never worker timeout code", () => {
    for (const path of HUMAN_DECISION_FILES) {
      expect(statSync(join(REPO_ROOT, path)).isFile()).toBe(true);
      expect(path.startsWith("apps/worker/")).toBe(false);
      expect(EXPIRY_WORD.test(path)).toBe(false);
    }
  });

  it("covers the migrations folder with the planted DB-side shapes (trigger, cron, case expression)", () => {
    const findings = fixture("db-trigger.sql.fixture");
    expect(rulesOf(findings)).toEqual(["R3-sql-approve"]);
    const snippets = findings.map((f) => f.snippet).join("\n");
    expect(snippets).toContain("new.status := 'approved'");
    expect(snippets).toContain("new.status = 'approved'");
    expect(snippets).toContain("set status = 'approved'");
    expect(snippets).toContain("case when");
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });
});

describe("AGO-51 AC1: the check fails on each planted shape", () => {
  it("a direct update, as a property and as an assignment", () => {
    const findings = fixture("direct-update.ts.fixture");
    expect(findings.filter((f) => f.rule === "R1-status-write")).toHaveLength(2);
  });

  it("a computed status variable (a constant, then a concatenation)", () => {
    const findings = fixture("computed-status.ts.fixture");
    expect(rulesOf(findings)).toContain("R1-status-write");
  });

  it("a SQL string in TypeScript, literal and parameter-bound", () => {
    const findings = fixture("sql-string.ts.fixture");
    expect(findings.filter((f) => f.rule === "R3-sql-approve")).toHaveLength(2);
  });

  it("a ternary on expiry that resolves to allow or proceed", () => {
    const findings = fixture("ternary-expiry.ts.fixture");
    expect(findings.filter((f) => f.rule === "R2-timeout-allows").length).toBeGreaterThanOrEqual(2);
  });

  it("a timeout-decided approved event and a timeout handler that runs the call", () => {
    const findings = fixture("timeout-event.ts.fixture");
    expect(rulesOf(findings)).toEqual(["R2-timeout-allows"]);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("reports nothing for look-alikes that only read approved or only deny", () => {
    expect(fixture("clean.ts.fixture")).toEqual([]);
    expect(fixture("clean.sql.fixture")).toEqual([]);
  });
});

describe("AGO-51 AC1: the widened shapes are caught", () => {
  it('a setter called with the literal approved (setStatus(id, "approved"))', () => {
    const findings = fixture("call-literal.ts.fixture");
    expect(rulesOf(findings)).toEqual(["R1-status-write"]);
    expect(findings).toHaveLength(1);
  });

  it("a const or alias bound to approved or APPROVAL_STATUS.approved, then written", () => {
    const findings = fixture("alias-approved.ts.fixture");
    expect(rulesOf(findings)).toEqual(["R1-status-write"]);
    expect(findings).toHaveLength(5);
  });

  it("a SQL string built with + from a variable bound to approved", () => {
    const findings = fixture("sql-concat.ts.fixture");
    expect(rulesOf(findings)).toEqual(["R3-sql-approve"]);
    expect(findings).toHaveLength(2);
  });

  it("a plpgsql status built with || and written from a variable", () => {
    const findings = fixture("sql-concat.sql.fixture");
    expect(rulesOf(findings)).toEqual(["R3-sql-approve"]);
    expect(findings).toHaveLength(1);
  });

  it("a comparison against approved is not a write (negative fixture, must report nothing)", () => {
    expect(fixture("clean-comparisons.sql.fixture")).toEqual([]);
  });

  it("a plpgsql variable declared with a default (:= or default) and written: set status = v, v::text, new.status = v, a chain", () => {
    const findings = fixture("plpgsql-declare.sql.fixture");
    expect(rulesOf(findings)).toEqual(["R3-sql-approve"]);
    expect(findings).toHaveLength(4);
    const snippets = findings.map((f) => f.snippet).join("\n");
    expect(snippets).toContain("set status = v::text");
    expect(snippets).toContain("new.status = w");
  });

  it("a declared variable bound to pending, and a default-bound guard, stay clean (negative fixture)", () => {
    expect(fixture("plpgsql-declare-clean.sql.fixture")).toEqual([]);
  });
});

describe("AGO-51 AC1: the check catches a violation planted in the real code", () => {
  const real = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

  it("sees the sweeper's SQL turn into an approval when its bound status becomes approved", () => {
    const path = "apps/worker/src/approvals/approval-store.ts";
    const original = real(path);
    expect(scanSource(path, original)).toEqual([]);
    const planted = original.replaceAll("APPROVAL_STATUS.rejected", "APPROVAL_STATUS.approved");
    expect(planted).not.toBe(original);
    expect(rulesOf(scanSource(path, planted))).toContain("R3-sql-approve");
  });

  it("sees the expiry sweep gain a path that approves", () => {
    const path = "apps/worker/src/approvals/expire-approvals.ts";
    const original = real(path);
    expect(scanSource(path, original)).toEqual([]);
    const planted = `${original}\nexport const expireAndApprove = () => ({ status: "approved" });\n`;
    expect(rulesOf(scanSource(path, planted))).toEqual(
      expect.arrayContaining(["R1-status-write", "R2-timeout-allows"]),
    );
  });
});
