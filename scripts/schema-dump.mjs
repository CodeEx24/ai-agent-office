// Order-insensitive form of a `pg_dump -s` text, for the rollback tests (AGO-202).
//
// The rollback tests compare the schema before and after "roll back, re-apply". Re-adding a column puts it last
// in the table, and a later migration (AGO-141 adds role/model/prompt after AGO-96's department_id) then makes
// the raw text differ although the schema is the same: column position is not part of the schema contract, and
// pg_dump orders column comments by it. Two tests that mutate the shared database also leave the physical order
// changed for the next one, so the result depended on which test ran first.
//
// So the column and constraint lines of each CREATE TABLE are sorted, and so are the top-level dump entries
// (the "-- Name: ...; Type: ..." blocks). Every column, type, default, constraint, policy, comment and grant is
// still compared: an object that is missing, extra or changed still fails. Only the order is ignored.

const TABLE_START = /^CREATE TABLE .*[(]$/;
const ENTRY_BREAK = /\n(?=--\n-- Name: )/;

function sortTableBodies(lines) {
  const out = [];
  let body = null;
  for (const line of lines) {
    if (body === null) {
      out.push(line);
      if (TABLE_START.test(line)) body = [];
    } else if (line === ');') {
      const sorted = body.map((l) => l.replace(/,$/, '')).sort();
      out.push(...sorted.map((l, i) => (i < sorted.length - 1 ? `${l},` : l)), line);
      body = null;
    } else {
      body.push(line);
    }
  }
  return out;
}

/** `dump`: the text of `pg_dump -s`, with pg_dump's random \restrict tokens already removed. */
export function normalizeSchemaDump(dump) {
  const text = sortTableBodies(dump.split('\n')).join('\n');
  const [preamble, ...entries] = text.split(ENTRY_BREAK);
  return [preamble, ...entries.sort()].join('\n');
}
