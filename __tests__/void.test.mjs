import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  computeBalances, simplifyDebts, summarize, expensesInRange, postedOccurrenceKeys,
  isVoided, liveExpenses, voidStatement, VOID_REASON_MAX,
  reversedPaymentIds, reversalPairs, isReversalOf, canReverse, reversalOf,
  cents, expenseProblem,
} from '../src/logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf-8');
const manifest = JSON.parse(read('manifest.json'));
const src = read('src/index.html');

const exp = (id, paidBy, cents, extra = {}) => ({
  id, paid_by: paidBy, amount_cents: cents, description: id, category: 'food',
  date: '2026-11-03', ...extra,
});
const split = (id, expenseId, memberId, cents) => ({ id, expense_id: expenseId, member_id: memberId, amount_cents: cents });

const EXPENSES = [
  exp('e1', 'ana', 8000),
  exp('e2', 'ben', 2000, { voided_at: '2026-11-04T09:00:00Z', voided_by_id: 'ana', void_reason: 'Twice' }),
];
const SPLITS = [
  split('s1', 'e1', 'ana', 4000), split('s2', 'e1', 'ben', 4000),
  split('s3', 'e2', 'ana', 1000), split('s4', 'e2', 'ben', 1000),
];

describe('removed expenses', () => {
  it('isVoided reads voided_at only', () => {
    expect(isVoided(EXPENSES[0])).toBe(false);
    expect(isVoided(EXPENSES[1])).toBe(true);
    expect(isVoided({ voided_at: null })).toBe(false);
    // As the SQL filter (`voided_at IS NULL`) reads it.
    expect(isVoided({ voided_at: '' })).toBe(true);
    expect(isVoided(null)).toBe(false);
  });

  it('liveExpenses drops removed rows and tolerates no list', () => {
    expect(liveExpenses(EXPENSES).map(e => e.id)).toEqual(['e1']);
    expect(liveExpenses(undefined)).toEqual([]);
  });

  it('a removed expense moves no money, and its payer is not seeded', () => {
    expect(computeBalances(EXPENSES, SPLITS, [])).toEqual({ ana: 4000, ben: -4000 });
    expect(computeBalances([EXPENSES[1]], SPLITS, [])).toEqual({});
  });

  it('summaries and ranges leave a removed expense out', () => {
    expect(expensesInRange(EXPENSES).map(e => e.id)).toEqual(['e1']);
    expect(expensesInRange(EXPENSES, { from: '2026-11-01', to: '2026-11-30' }).map(e => e.id)).toEqual(['e1']);
    const sum = summarize(EXPENSES, SPLITS);
    expect(sum.total_cents).toBe(8000);
    expect(sum.count).toBe(1);
    const ben = sum.byMember.find(m => m.member_id === 'ben');
    expect(ben).toEqual({ member_id: 'ben', paid_cents: 0, share_cents: 4000, net_cents: -4000 });
  });

  it('a removed repeating occurrence still counts as posted, so it never posts again', () => {
    const occ = exp('e3', 'ana', 100, { recurring_id: 'rent', occurrence_date: '2026-11-01', voided_at: '2026-11-02T00:00:00Z' });
    expect(postedOccurrenceKeys([occ]).has('rent|2026-11-01')).toBe(true);
  });

  it('voidStatement stamps who, when and why, guarded on not already removed', () => {
    const st = voidStatement('e1', 'ana', '  Logged twice  ', '2026-11-04T09:00:00Z');
    expect(st.sql).toBe('UPDATE app_expense_splitter__expenses SET voided_at = ?, voided_by_id = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL');
    expect(st.params).toEqual(['2026-11-04T09:00:00Z', 'ana', 'Logged twice', 'e1']);
  });

  it('a blank reason is written as NULL, never an empty string (the codec refuses one)', () => {
    expect(voidStatement('e1', 'ana', '   ', 'now').params[2]).toBeNull();
    expect(voidStatement('e1', 'ana', undefined, 'now').params[2]).toBeNull();
  });

  it('a reason is capped', () => {
    expect(voidStatement('e1', 'ana', 'x'.repeat(500), 'now').params[2]).toHaveLength(VOID_REASON_MAX);
  });

});

describe('reversed payments', () => {
  const p1 = { id: 'p1', from_id: 'ana', to_id: 'ben', amount_cents: 20000, settled_at: '2026-11-07T10:00:00Z' };

  it('reversalOf is the same amount the other way, naming the original', () => {
    expect(reversalOf(p1, 'Nov 7, 2026')).toEqual({
      from_id: 'ben', to_id: 'ana', amount_cents: 20000,
      note: 'Reverses the payment of Nov 7, 2026', reverses_id: 'p1',
    });
  });

  it('a payment and its reversal net to the balance before the mistake', () => {
    const before = computeBalances(EXPENSES, SPLITS, []);
    const r = { id: 'p2', ...reversalOf(p1, 'x') };
    expect(computeBalances(EXPENSES, SPLITS, [p1, r])).toEqual(before);
    expect(simplifyDebts(computeBalances(EXPENSES, SPLITS, [p1, r]))).toEqual(simplifyDebts(before));
  });

  it('a payment can be reversed once, and a reversal cannot be reversed', () => {
    const r = { id: 'p2', ...reversalOf(p1, 'x') };
    expect(canReverse(p1, [p1])).toBe(true);
    expect(canReverse(p1, [p1, r])).toBe(false);
    expect(canReverse(r, [p1, r])).toBe(false);
    expect(canReverse(null, [])).toBe(false);
    expect([...reversedPaymentIds([p1, r])]).toEqual(['p1']);
  });

  // The hub cannot check that a row naming a payment is its true reverse, so
  // the page counts only one that is: anything else is an ordinary payment.
  it('a row that names a payment but does not match it neither reverses it nor is a reversal', () => {
    const good = { id: 'p2', ...reversalOf(p1, 'x') };
    const wrongAmount = { ...good, id: 'b1', amount_cents: 1 };
    const sameWay = { ...good, id: 'b2', from_id: 'ana', to_id: 'ben' };
    const otherParty = { ...good, id: 'b3', to_id: 'cat' };
    for (const bogus of [wrongAmount, sameWay, otherParty]) {
      expect(isReversalOf(bogus, p1)).toBe(false);
      expect(canReverse(p1, [p1, bogus])).toBe(true);
      expect(reversalPairs([p1, bogus]).reversals.size).toBe(0);
      // An ordinary payment: it may itself be reversed.
      expect(canReverse(bogus, [p1, bogus])).toBe(true);
    }
    // The matching reversal still counts beside a bogus one.
    const pairs = reversalPairs([p1, wrongAmount, good]);
    expect([...pairs.reversed]).toEqual(['p1']);
    expect([...pairs.reversals]).toEqual(['p2']);
    expect(isReversalOf(good, p1)).toBe(true);
  });

  // SQLite keeps a value it cannot read as a number as TEXT, even in an
  // INTEGER column. Number('0x1388') is 5000; SQL reads it as 0.
  it('an amount counts only when it is a whole number of cents', () => {
    for (const bad of ['0x1388', '20000', '', '2e4', 200.5, null, undefined, NaN]) {
      expect(cents(bad)).toBe(null);
    }
    expect(cents(20000)).toBe(20000);
    expect(cents(0)).toBe(0);
  });

  it('a text amount neither fakes a reversal nor moves money', () => {
    const fake = { id: 'b9', ...reversalOf(p1, 'x'), amount_cents: '20000' };
    expect(isReversalOf(fake, p1)).toBe(false);
    expect(canReverse(p1, [p1, fake])).toBe(true);
    // A payment whose own amount does not count has nothing to reverse.
    expect(canReverse({ ...p1, amount_cents: '0x4e20' }, [])).toBe(false);
    const before = computeBalances(EXPENSES, SPLITS, [p1]);
    const after = computeBalances(EXPENSES, [...SPLITS, split('sx', 'e1', 'ben', '0x1388')], [p1, fake]);
    expect(after).toEqual(before);
    for (const v of Object.values(after)) expect(Number.isFinite(v)).toBe(true);
    const sum = summarize([...EXPENSES, exp('e9', 'ana', '0x1388')], SPLITS);
    expect(sum.total_cents).toBe(8000);
  });

  // The warning, the summary and the balance must agree: an expense whose
  // amount does not count moves no money, even through valid shares.
  it('an expense with a text amount moves no money, whatever its shares', () => {
    const bad = exp('e9', 'ana', '0x4b0');
    const badSplits = [split('s9', 'e9', 'ana', 600), split('s10', 'e9', 'ben', 1200)];
    const before = computeBalances(EXPENSES, SPLITS, []);
    expect(computeBalances([...EXPENSES, bad], [...SPLITS, ...badSplits], [])).toEqual(before);
    const sum = summarize([...EXPENSES, bad], [...SPLITS, ...badSplits]);
    expect(sum.total_cents).toBe(8000);
    // By person agrees with the balance: the bad expense's shares add nothing.
    expect(sum.byMember).toEqual(summarize(EXPENSES, SPLITS).byMember);
    expect(expenseProblem(bad, badSplits)).toMatch(/counts as nothing/);
  });

  it('a row naming a payment that is not there is an ordinary payment', () => {
    const orphan = { id: 'p2', ...reversalOf(p1, 'x') };
    expect(reversalPairs([orphan]).reversals.size).toBe(0);
    expect(canReverse(orphan, [orphan])).toBe(true);
  });
});

describe('expenses whose shares do not add up', () => {
  it('an expense recorded by the page has no problem', () => {
    expect(expenseProblem(EXPENSES[0], SPLITS.filter(s => s.expense_id === 'e1'))).toBe(null);
  });
  it('an extra share, a text share, a missing split or a text amount is flagged', () => {
    const e1 = SPLITS.filter(s => s.expense_id === 'e1');
    expect(expenseProblem(EXPENSES[0], [...e1, split('sx', 'e1', 'cat', 500)])).toMatch(/don't add up/);
    expect(expenseProblem(EXPENSES[0], [e1[0], { ...e1[1], amount_cents: '4000' }])).toMatch(/don't add up/);
    expect(expenseProblem(EXPENSES[0], [])).toMatch(/don't add up/);
    expect(expenseProblem({ ...EXPENSES[0], amount_cents: '8000' }, e1)).toMatch(/whole number/);
  });
});

describe('manifest: recorded values are locked against UPDATE', () => {
  const LOCK = { writable_by: [], actions: ['update'] };
  const VOID_COLUMNS = ['voided_at', 'voided_by_id', 'void_reason'];

  it('every expense column but the three void columns is locked', () => {
    const acls = manifest.row_policies.expenses.column_write_acls;
    for (const col of ['id', 'paid_by', 'amount_cents', 'description', 'category', 'date', 'split_type',
      'created_at', 'receipt_file_id', 'recurring_id', 'occurrence_date']) {
      expect(acls[col], col).toEqual(LOCK);
    }
    for (const col of VOID_COLUMNS) expect(acls[col], col).toBeUndefined();
  });

  it('every column of a share and of a payment is locked', () => {
    for (const col of ['id', 'expense_id', 'member_id', 'amount_cents']) {
      expect(manifest.row_policies.expense_splits.column_write_acls[col], col).toEqual(LOCK);
    }
    for (const col of ['id', 'from_id', 'to_id', 'amount_cents', 'note', 'settled_at', 'created_at', 'reverses_id']) {
      expect(manifest.row_policies.settlements.column_write_acls[col], col).toEqual(LOCK);
    }
  });

  it('the lock covers every column the migrations create on the three tables', () => {
    const migrations = ['001_init.sql', '003_reimbursements.sql', '005_recurring_expenses.sql', '006_void_expenses.sql']
      .map(f => read(`migrations/${f}`)).join('\n');
    const cols = (table) => {
      const out = new Set();
      const create = new RegExp(`CREATE TABLE IF NOT EXISTS app_expense_splitter__${table} \\(([\\s\\S]*?)\\n\\);`).exec(migrations);
      for (const line of create[1].split('\n')) {
        const m = /^\s+([a-z_]+)\s+[A-Z]/.exec(line);
        if (m && m[1] !== 'PRIMARY') out.add(m[1]);
      }
      for (const m of migrations.matchAll(new RegExp(`ALTER TABLE app_expense_splitter__${table} ADD COLUMN ([a-z_]+)`, 'g'))) out.add(m[1]);
      return out;
    };
    for (const table of ['expenses', 'expense_splits', 'settlements']) {
      const acls = manifest.row_policies[table].column_write_acls;
      for (const col of cols(table)) {
        if (table === 'expenses' && VOID_COLUMNS.includes(col)) continue;
        expect(acls[col], `${table}.${col}`).toEqual(LOCK);
      }
    }
  });

  it('the ledger tables are kept in record mode, and only those', () => {
    const kept = Object.entries(manifest.row_policies).filter(([, p]) => p.kept_in_record_mode).map(([t]) => t);
    expect(kept.sort()).toEqual(['expense_splits', 'expenses', 'settlements']);
    // Stopping a repeating expense deletes its template, and a parent can
    // clear their own payment username: neither is kept.
    expect(manifest.row_policies.recurring_expenses.kept_in_record_mode).toBeUndefined();
    expect(manifest.row_policies.payment_handles.kept_in_record_mode).toBeUndefined();
  });

  it('who removed an expense is kept when that member leaves', () => {
    expect(manifest.member_references.expenses).toContainEqual({ column: 'voided_by_id', on_removed: 'keep' });
  });

  it('the ledger and shares views list removed expenses with who, when and why', () => {
    const [ledger, shares] = manifest.reports.views;
    expect(ledger.source.query).not.toMatch(/voided_at IS NULL/);
    expect(ledger.source.query).toContain('e.voided_at AS removed_at, e.voided_by_id AS removed_by, CASE WHEN e.voided_at IS NOT NULL THEN e.void_reason END AS removed_reason');
    // The Check column flags a text amount and shares that do not add up.
    expect(ledger.source.query).toMatch(/typeof\(e\.amount_cents\) <> 'integer'/);
    expect(ledger.columns.map(c => c.key)).toContain('problem');
    // A reversal is linked in the export only when it truly matches.
    const payments = manifest.reports.views.find(v => v.id === 'settlements');
    expect(payments.source.query).toContain('o.from_id = p.to_id AND o.to_id = p.from_id');
    expect(ledger.columns.map(c => c.key)).toEqual(expect.arrayContaining(['removed_at', 'removed_by', 'removed_reason']));
    expect(shares.source.query).toContain('e.voided_at AS removed_at');
  });

  it('the named queries AI access reads leave removed expenses out', () => {
    for (const q of ['category_totals', 'recent_expenses']) {
      expect(read(`src/queries/${q}.sql`), q).toContain('WHERE e.voided_at IS NULL');
    }
    const pending = read('src/queries/pending_balances.sql');
    expect(pending.match(/WHERE e\.voided_at IS NULL/g)).toHaveLength(2);
  });
});

describe('page wiring', () => {
  it('never deletes an expense or its receipt', () => {
    expect(src).not.toContain('DELETE FROM app_expense_splitter__expenses');
    expect(src).not.toContain('_deleteExpense');
    const i = src.indexOf('window._submitRemove = async function');
    const body = src.slice(i, src.indexOf('\n};\n', i));
    expect(body).toContain('voidStatement(expId, ME.id, reason');
    expect(body).not.toContain('FILES.delete');
  });

  it('never updates a payment, and records a reversal naming the original', () => {
    expect(src).not.toMatch(/UPDATE app_expense_splitter__settlements/);
    expect(src).not.toContain('DELETE FROM app_expense_splitter__settlements');
    expect(src).toContain('INSERT INTO app_expense_splitter__settlements (id, from_id, to_id, amount_cents, note, settled_at, created_at, reverses_id) VALUES (?,?,?,?,?,?,?,?)');
  });

  it('offers Reverse only to an adult party to a payment that can still be reversed', () => {
    const i = src.indexOf('function paymentRow(p');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    expect(body).toContain('IS_ADULT && party && reversible(p, pairs, counted)');
  });

  // A payment recorded for a reimbursement request leaves the balance only once
  // the requests are read: while they are unread, nothing may be reversed.
  it('offers and submits Reverse only while the requests are loaded and the payment counts in the balance', () => {
    const i = src.indexOf('function reversible(');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    expect(body).toContain('!requestsFailed && canReverse(p, settlements, pairs) && counted.has(p.id)');
    expect(src.slice(i, i + 200)).toContain('counted = new Set(balancePayments().map(x => x.id))');
    // The list builds the counted set once, not once per row.
    expect(src).toContain('const counted = new Set(all.map(x => x.id));');
    const j = src.indexOf('window._submitReverse = async function');
    const submit = src.slice(j, src.indexOf('\n};\n', j));
    expect(submit).toContain('if (requestsFailed || !balancePayments().some(x => x.id === p.id))');
    const k = src.indexOf('window._openReverse = function');
    expect(src.slice(k, k + 200)).toContain('!reversible(p)');
  });
});
