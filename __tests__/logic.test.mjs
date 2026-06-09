import { describe, it, expect } from 'vitest';
import {
  computeBalances,
  simplifyDebts,
  computeSplits,
  validateCustomSplits,
  fmtSplit,
  fmtDate,
  today,
  categoryFor,
  CATEGORIES,
} from '../src/logic.js';

// ── computeSplits ─────────────────────────────────────────────────────────────

describe('computeSplits – equal', () => {
  it('splits evenly into three equal parts', () => {
    const result = computeSplits(9000, ['a', 'b', 'c'], 'equal');
    expect(result).toEqual([
      { member_id: 'a', amount_cents: 3000 },
      { member_id: 'b', amount_cents: 3000 },
      { member_id: 'c', amount_cents: 3000 },
    ]);
  });

  it('distributes remainder pennies to early members', () => {
    // $10.00 ÷ 3 → 334, 333, 333 (sums to 1000)
    const result = computeSplits(1000, ['a', 'b', 'c'], 'equal');
    expect(result[0].amount_cents).toBe(334);
    expect(result[1].amount_cents).toBe(333);
    expect(result[2].amount_cents).toBe(333);
    const total = result.reduce((s, x) => s + x.amount_cents, 0);
    expect(total).toBe(1000);
  });

  it('handles a single member (solo expense)', () => {
    const result = computeSplits(5000, ['a'], 'equal');
    expect(result).toEqual([{ member_id: 'a', amount_cents: 5000 }]);
  });

  it('returns empty array when no members', () => {
    expect(computeSplits(5000, [], 'equal')).toEqual([]);
  });
});

describe('computeSplits – custom', () => {
  it('uses provided custom amounts', () => {
    const result = computeSplits(10000, ['a', 'b'], 'custom', { a: 7000, b: 3000 });
    expect(result).toEqual([
      { member_id: 'a', amount_cents: 7000 },
      { member_id: 'b', amount_cents: 3000 },
    ]);
  });

  it('defaults missing custom amounts to 0', () => {
    const result = computeSplits(10000, ['a', 'b'], 'custom', { a: 10000 });
    expect(result[1].amount_cents).toBe(0);
  });
});

// ── validateCustomSplits ──────────────────────────────────────────────────────

describe('validateCustomSplits', () => {
  it('passes when amounts sum to the total', () => {
    expect(validateCustomSplits(10000, { a: 7000, b: 3000 })).toBe(true);
  });

  it('fails when amounts are under', () => {
    expect(validateCustomSplits(10000, { a: 5000, b: 3000 })).toBe(false);
  });

  it('fails when amounts are over', () => {
    expect(validateCustomSplits(10000, { a: 7000, b: 4000 })).toBe(false);
  });

  it('passes for a single member covering the full amount', () => {
    expect(validateCustomSplits(5000, { a: 5000 })).toBe(true);
  });
});

// ── computeBalances ───────────────────────────────────────────────────────────

describe('computeBalances', () => {
  it('records a simple two-person debt', () => {
    const expenses = [{ id: 'e1', paid_by: 'alice', amount_cents: 6000 }];
    const splits   = [
      { id: 's1', expense_id: 'e1', member_id: 'alice', amount_cents: 3000 },
      { id: 's2', expense_id: 'e1', member_id: 'bob',   amount_cents: 3000 },
    ];
    const bal = computeBalances(expenses, splits, []);
    expect(bal.alice).toBe(3000);
    expect(bal.bob).toBe(-3000);
  });

  it('handles a three-way equal split', () => {
    const expenses = [{ id: 'e1', paid_by: 'alice', amount_cents: 9000 }];
    const splits   = [
      { id: 's1', expense_id: 'e1', member_id: 'alice', amount_cents: 3000 },
      { id: 's2', expense_id: 'e1', member_id: 'bob',   amount_cents: 3000 },
      { id: 's3', expense_id: 'e1', member_id: 'carol', amount_cents: 3000 },
    ];
    const bal = computeBalances(expenses, splits, []);
    expect(bal.alice).toBe(6000);
    expect(bal.bob).toBe(-3000);
    expect(bal.carol).toBe(-3000);
  });

  it('reduces debt after a partial settlement', () => {
    const expenses = [{ id: 'e1', paid_by: 'alice', amount_cents: 6000 }];
    const splits   = [
      { id: 's1', expense_id: 'e1', member_id: 'alice', amount_cents: 3000 },
      { id: 's2', expense_id: 'e1', member_id: 'bob',   amount_cents: 3000 },
    ];
    const settlements = [{ id: 'p1', from_id: 'bob', to_id: 'alice', amount_cents: 2000 }];
    const bal = computeBalances(expenses, splits, settlements);
    expect(bal.alice).toBe(1000);
    expect(bal.bob).toBe(-1000);
  });

  it('zeroes out balances after a full settlement', () => {
    const expenses = [{ id: 'e1', paid_by: 'alice', amount_cents: 6000 }];
    const splits   = [
      { id: 's1', expense_id: 'e1', member_id: 'alice', amount_cents: 3000 },
      { id: 's2', expense_id: 'e1', member_id: 'bob',   amount_cents: 3000 },
    ];
    const settlements = [{ id: 'p1', from_id: 'bob', to_id: 'alice', amount_cents: 3000 }];
    const bal = computeBalances(expenses, splits, settlements);
    expect(bal.alice).toBe(0);
    expect(bal.bob).toBe(0);
  });

  it('handles multiple expenses from different payers', () => {
    const expenses = [
      { id: 'e1', paid_by: 'alice', amount_cents: 6000 },
      { id: 'e2', paid_by: 'bob',   amount_cents: 4000 },
    ];
    const splits = [
      { id: 's1', expense_id: 'e1', member_id: 'alice', amount_cents: 3000 },
      { id: 's2', expense_id: 'e1', member_id: 'bob',   amount_cents: 3000 },
      { id: 's3', expense_id: 'e2', member_id: 'alice', amount_cents: 2000 },
      { id: 's4', expense_id: 'e2', member_id: 'bob',   amount_cents: 2000 },
    ];
    const bal = computeBalances(expenses, splits, []);
    // alice paid 3k for bob, bob paid 2k for alice → net: alice owed 1k
    expect(bal.alice).toBe(1000);
    expect(bal.bob).toBe(-1000);
  });

  it('does not count the payer\'s own split against their balance', () => {
    const expenses = [{ id: 'e1', paid_by: 'alice', amount_cents: 3000 }];
    const splits   = [{ id: 's1', expense_id: 'e1', member_id: 'alice', amount_cents: 3000 }];
    const bal = computeBalances(expenses, splits, []);
    // Alice paid only for herself — no debt created
    expect(bal.alice ?? 0).toBe(0);
  });
});

// ── simplifyDebts ─────────────────────────────────────────────────────────────

describe('simplifyDebts', () => {
  it('produces a single transaction for a two-person debt', () => {
    const txns = simplifyDebts({ alice: 3000, bob: -3000 });
    expect(txns).toEqual([{ from_id: 'bob', to_id: 'alice', amount_cents: 3000 }]);
  });

  it('returns empty when all balances are zero', () => {
    expect(simplifyDebts({ a: 0, b: 0, c: 0 })).toEqual([]);
  });

  it('returns empty for an empty balance map', () => {
    expect(simplifyDebts({})).toEqual([]);
  });

  it('minimises transaction count for three-way debts', () => {
    // alice owed $60, bob owes $10, carol owes $50
    const txns = simplifyDebts({ alice: 6000, bob: -1000, carol: -5000 });
    expect(txns.length).toBeLessThanOrEqual(2);
    const totalPaid = txns.reduce((s, t) => s + t.amount_cents, 0);
    expect(totalPaid).toBe(6000);
    // Every transaction must credit alice
    txns.forEach(t => expect(t.to_id).toBe('alice'));
  });

  it('the sum of all from-amounts equals the sum of all to-amounts (net zero)', () => {
    const bal = { a: 5000, b: -3000, c: -2000 };
    const txns = simplifyDebts(bal);
    const outflow = txns.reduce((s, t) => s + t.amount_cents, 0);
    expect(outflow).toBe(5000);
  });
});

// ── fmtSplit ──────────────────────────────────────────────────────────────────

describe('fmtSplit', () => {
  it('formats whole dollar amounts without decimals', () => {
    expect(fmtSplit(5000)).toBe('$50');
  });

  it('formats non-whole amounts with two decimal places', () => {
    expect(fmtSplit(4567)).toBe('$45.67');
  });

  it('shows minus sign for negative values', () => {
    expect(fmtSplit(-3000)).toBe('-$30');
  });

  it('handles null as $0', () => {
    expect(fmtSplit(null)).toBe('$0');
  });

  it('formats zero correctly', () => {
    expect(fmtSplit(0)).toBe('$0');
  });
});

// ── fmtDate ───────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('returns empty string for falsy input', () => {
    expect(fmtDate('')).toBe('');
    expect(fmtDate(null)).toBe('');
  });

  it('formats a date in the current year without the year', () => {
    const result = fmtDate(today());
    expect(result).toMatch(/\w+ \d+/);      // e.g. "Jun 8"
    expect(result).not.toMatch(/\d{4}/);    // no year
  });
});

// ── today ─────────────────────────────────────────────────────────────────────

describe('today', () => {
  it('returns a YYYY-MM-DD formatted string', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the current date', () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(today()).toBe(expected);
  });
});

// ── categoryFor ──────────────────────────────────────────────────────────────

describe('categoryFor', () => {
  it('returns the matching category', () => {
    const cat = categoryFor('food');
    expect(cat.label).toBe('Food & Dining');
    expect(cat.icon).toBe('🍔');
  });

  it('falls back to "other" for unknown ids', () => {
    const cat = categoryFor('nonexistent');
    expect(cat.id).toBe('other');
  });

  it('covers all CATEGORIES ids without falling back', () => {
    for (const cat of CATEGORIES) {
      expect(categoryFor(cat.id).id).toBe(cat.id);
    }
  });
});
