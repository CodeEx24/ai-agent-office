// AGO-202: the order-insensitive schema comparison used by the rollback tests ignores order only.
import { describe, expect, it } from 'vitest';
import { normalizeSchemaDump } from './schema-dump.mjs';

const dump = (columns, comments) =>
  [
    'SET statement_timeout = 0;',
    '',
    '--',
    '-- Name: agents; Type: TABLE; Schema: public; Owner: -',
    '--',
    '',
    'CREATE TABLE public.agents (',
    ...columns,
    ');',
    '',
    ...comments.flatMap((c) => ['--', `-- Name: COLUMN agents.${c}; Type: COMMENT; Schema: public; Owner: -`, '--', '', `COMMENT ON COLUMN public.agents.${c} IS 'x';`, '']),
  ].join('\n');

const A = ['    id uuid NOT NULL,', '    department_id uuid,', "    role text DEFAULT ''::text NOT NULL,", '    CONSTRAINT agents_role_check CHECK ((char_length(role) <= 120))'];
const B = ['    id uuid NOT NULL,', "    role text DEFAULT ''::text NOT NULL,", '    department_id uuid,', '    CONSTRAINT agents_role_check CHECK ((char_length(role) <= 120))'];
const BOTH = ['department_id', 'role'];

describe('normalizeSchemaDump', () => {
  it('treats a different column and comment order as the same schema', () => {
    expect(normalizeSchemaDump(dump(A, BOTH))).toBe(normalizeSchemaDump(dump(B, ['role', 'department_id'])));
  });

  it('still fails when a column is missing, changed or extra', () => {
    const base = normalizeSchemaDump(dump(A, BOTH));
    expect(normalizeSchemaDump(dump(A.filter((l) => !l.includes('department_id')), ['role']))).not.toBe(base);
    expect(normalizeSchemaDump(dump(A.map((l) => l.replace('uuid,', 'text,')), BOTH))).not.toBe(base);
    const extra = [...A.slice(0, -1), '    extra integer,', A[A.length - 1]];
    expect(normalizeSchemaDump(dump(extra, BOTH))).not.toBe(base);
  });

  it('still fails when a comment or constraint differs', () => {
    const base = normalizeSchemaDump(dump(A, BOTH));
    expect(normalizeSchemaDump(dump(A, ['role']))).not.toBe(base);
    expect(normalizeSchemaDump(dump(A.map((l) => l.replace('120', '121')), BOTH))).not.toBe(base);
  });
});
