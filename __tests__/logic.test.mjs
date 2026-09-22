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
  TOTAL_BP,
  splitPercentsForCategory,
  apportionByPercent,
  computeSplitsWithCategory,
  validateCategoryPercents,
  reimbursementStatus,
  validateReimbursement,
  CATEGORIES, searchableFields,
  apportionByWeight, apportionByShares, validateShares, splitTypeLabel, SPLIT_METHODS,
  monthKey, monthLabel, expenseMonths, rangeForPeriod, expensesInRange, summarize,
  sharesError, MAX_SHARES, CATEGORY_RULE_SPLIT,
  PAYMENT_SERVICES, paymentServiceFor, normalizeHandle, validateHandle, displayHandle,
  payLink, handleMap,
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

describe('splitPercentsForCategory', () => {
  const saved = [
    { category: 'health', member_id: 'a', percent_bp: 7000 },
    { category: 'health', member_id: 'b', percent_bp: 3000 },
    { category: 'food',   member_id: 'a', percent_bp: 5000 },
    { category: 'food',   member_id: 'b', percent_bp: 5000 },
  ];

  it('returns the saved rule in the order the members were passed', () => {
    expect(splitPercentsForCategory(saved, 'health', ['a', 'b'])).toEqual([
      { member_id: 'a', percent_bp: 7000 },
      { member_id: 'b', percent_bp: 3000 },
    ]);
    expect(splitPercentsForCategory(saved, 'health', ['b', 'a'])).toEqual([
      { member_id: 'b', percent_bp: 3000 },
      { member_id: 'a', percent_bp: 7000 },
    ]);
  });

  it('returns null when the category has no saved rule', () => {
    expect(splitPercentsForCategory(saved, 'travel', ['a', 'b'])).toBe(null);
    expect(splitPercentsForCategory([], 'health', ['a', 'b'])).toBe(null);
  });

  it('returns null rather than reallocating when the rule is stale', () => {
    // A member joined: the saved rule covers 2 of 3 people. Silently splitting
    // the expense 70/30 between two of them and giving the third nothing would
    // be a money bug, so fall back to an even split instead.
    expect(splitPercentsForCategory(saved, 'health', ['a', 'b', 'c'])).toBe(null);
    // A member left, and the rule still names them.
    expect(splitPercentsForCategory(saved, 'health', ['a'])).toBe(null);
    // Same count, different people.
    expect(splitPercentsForCategory(saved, 'health', ['a', 'z'])).toBe(null);
  });

  it('returns null when the saved rule does not add up to 100%', () => {
    const broken = [
      { category: 'x', member_id: 'a', percent_bp: 6000 },
      { category: 'x', member_id: 'b', percent_bp: 3000 },
    ];
    expect(splitPercentsForCategory(broken, 'x', ['a', 'b'])).toBe(null);
  });
});

describe('apportionByPercent', () => {
  const sum = (rows) => rows.reduce((s, r) => s + r.amount_cents, 0);

  it('splits evenly when the percentages divide cleanly', () => {
    expect(apportionByPercent(10000, [
      { member_id: 'a', percent_bp: 5000 },
      { member_id: 'b', percent_bp: 5000 },
    ])).toEqual([
      { member_id: 'a', amount_cents: 5000 },
      { member_id: 'b', amount_cents: 5000 },
    ]);
  });

  it('never loses or invents a penny', () => {
    // 34567¢ three ways is the classic rounding trap: 11522.33 each.
    const thirds = [
      { member_id: 'a', percent_bp: 3333 },
      { member_id: 'b', percent_bp: 3333 },
      { member_id: 'c', percent_bp: 3334 },
    ];
    for (const total of [1, 2, 3, 7, 99, 100, 101, 34567, 1000000]) {
      expect(sum(apportionByPercent(total, thirds))).toBe(total);
    }
  });

  it('gives leftover pennies to the largest remainder, deterministically', () => {
    // 100¢ at 70/30 is exact; 101¢ leaves one penny, and .7 beats .3.
    expect(apportionByPercent(101, [
      { member_id: 'a', percent_bp: 7000 },
      { member_id: 'b', percent_bp: 3000 },
    ])).toEqual([
      { member_id: 'a', amount_cents: 71 },
      { member_id: 'b', amount_cents: 30 },
    ]);
    // Tied remainders break toward the earlier member, both times.
    const tied = [
      { member_id: 'a', percent_bp: 5000 },
      { member_id: 'b', percent_bp: 5000 },
    ];
    expect(apportionByPercent(101, tied)).toEqual(apportionByPercent(101, tied));
    expect(apportionByPercent(101, tied)[0].amount_cents).toBe(51);
  });

  it('handles a zero total and an empty rule', () => {
    expect(apportionByPercent(0, [{ member_id: 'a', percent_bp: TOTAL_BP }]))
      .toEqual([{ member_id: 'a', amount_cents: 0 }]);
    expect(apportionByPercent(500, [])).toEqual([]);
  });

  it('gives everything to a 100% member', () => {
    expect(apportionByPercent(1234, [
      { member_id: 'a', percent_bp: TOTAL_BP },
      { member_id: 'b', percent_bp: 0 },
    ])).toEqual([
      { member_id: 'a', amount_cents: 1234 },
      { member_id: 'b', amount_cents: 0 },
    ]);
  });
});

describe('computeSplitsWithCategory', () => {
  const saved = [
    { category: 'health', member_id: 'a', percent_bp: 7000 },
    { category: 'health', member_id: 'b', percent_bp: 3000 },
  ];

  it('applies the category rule to an equal-type expense', () => {
    const { splits, source } = computeSplitsWithCategory(10000, ['a', 'b'], 'equal', {}, saved, 'health');
    expect(source).toBe('category');
    expect(splits).toEqual([
      { member_id: 'a', amount_cents: 7000 },
      { member_id: 'b', amount_cents: 3000 },
    ]);
  });

  it('falls back to an even split when no rule matches', () => {
    const { splits, source } = computeSplitsWithCategory(10000, ['a', 'b'], 'equal', {}, saved, 'travel');
    expect(source).toBe('equal');
    expect(splits.map(s => s.amount_cents)).toEqual([5000, 5000]);
  });

  it('lets an explicit custom split win over the category rule', () => {
    const { splits, source } = computeSplitsWithCategory(
      10000, ['a', 'b'], 'custom', { a: 9000, b: 1000 }, saved, 'health');
    expect(source).toBe('custom');
    expect(splits).toEqual([
      { member_id: 'a', amount_cents: 9000 },
      { member_id: 'b', amount_cents: 1000 },
    ]);
  });

  it('still totals the full expense under a category rule', () => {
    const { splits } = computeSplitsWithCategory(9999, ['a', 'b'], 'equal', {}, saved, 'health');
    expect(splits.reduce((s, x) => s + x.amount_cents, 0)).toBe(9999);
  });
});

describe('validateCategoryPercents', () => {
  it('accepts exactly 100% and rejects anything else', () => {
    expect(validateCategoryPercents([{ percent_bp: 5000 }, { percent_bp: 5000 }])).toBe(true);
    expect(validateCategoryPercents([{ percent_bp: 3333 }, { percent_bp: 3333 }, { percent_bp: 3334 }])).toBe(true);
    expect(validateCategoryPercents([{ percent_bp: 5000 }, { percent_bp: 4999 }])).toBe(false);
    expect(validateCategoryPercents([{ percent_bp: 5000 }, { percent_bp: 5001 }])).toBe(false);
    expect(validateCategoryPercents([])).toBe(false);
  });
});

describe('reimbursementStatus', () => {
  const req = (status) => ({ id: 'r1', status });

  it('derives the lock from the agreement row', () => {
    expect(reimbursementStatus(req('pending'), { status: 'locked' })).toBe('locked');
    expect(reimbursementStatus(req('pending'), { status: 'pending' })).toBe('pending');
    expect(reimbursementStatus(req('pending'), undefined)).toBe('pending');
  });

  it('lets terminal states on the request win over the lock', () => {
    expect(reimbursementStatus(req('cancelled'), { status: 'locked' })).toBe('cancelled');
    expect(reimbursementStatus(req('settled'), { status: 'locked' })).toBe('settled');
  });
});

describe('validateReimbursement', () => {
  const base = { requester_id: 'a', payer_id: 'b', amount_cents: 1000 };

  it('accepts a well-formed request', () => {
    expect(validateReimbursement(base)).toEqual({ ok: true });
  });
  it('rejects a missing or self payer', () => {
    expect(validateReimbursement({ ...base, payer_id: '' }).ok).toBe(false);
    expect(validateReimbursement({ ...base, payer_id: 'a' }).ok).toBe(false);
  });
  it('rejects non-positive, fractional, and absurd amounts', () => {
    for (const amount_cents of [0, -100, 12.5, NaN, '1000', null]) {
      expect(validateReimbursement({ ...base, amount_cents }).ok).toBe(false);
    }
    expect(validateReimbursement({ ...base, amount_cents: 100_000_001 }).ok).toBe(false);
  });
});

describe("searchableFields", () => {
  it("reaches the category and note, not just the description", () => {
    const fields = searchableFields({ description: "Weekly shop", category: "groceries", note: "Tesco" });
    expect(fields).toContain("groceries");
    expect(fields).toContain("Tesco");
  });
});

// ── shares & per-expense percent ─────────────────────────────────────────────

describe('apportionByShares', () => {
  const sum = (rows) => rows.reduce((s, r) => s + r.amount_cents, 0);

  it('gives a 2:1:1 split exactly a half and two quarters', () => {
    expect(apportionByShares(10000, [
      { member_id: 'a', shares: 2 },
      { member_id: 'b', shares: 1 },
      { member_id: 'c', shares: 1 },
    ])).toEqual([
      { member_id: 'a', amount_cents: 5000 },
      { member_id: 'b', amount_cents: 2500 },
      { member_id: 'c', amount_cents: 2500 },
    ]);
  });

  it('never loses or invents a penny, at any total', () => {
    const shares = [
      { member_id: 'a', shares: 2 },
      { member_id: 'b', shares: 1 },
      { member_id: 'c', shares: 1 },
    ];
    for (let total = 1; total <= 400; total++) {
      expect(sum(apportionByShares(total, shares)), `total ${total}`).toBe(total);
    }
  });

  it('breaks a tied remainder toward the earlier member, like every other mode', () => {
    expect(apportionByShares(101, [
      { member_id: 'a', shares: 1 },
      { member_id: 'b', shares: 1 },
    ])).toEqual([
      { member_id: 'a', amount_cents: 51 },
      { member_id: 'b', amount_cents: 50 },
    ]);
  });

  it('gives a member with zero shares nothing', () => {
    const out = apportionByShares(900, [
      { member_id: 'a', shares: 2 },
      { member_id: 'b', shares: 0 },
      { member_id: 'c', shares: 1 },
    ]);
    expect(out.find(r => r.member_id === 'b').amount_cents).toBe(0);
    expect(sum(out)).toBe(900);
  });

  it('pays nobody rather than dividing by zero when every share is zero', () => {
    const out = apportionByShares(900, [
      { member_id: 'a', shares: 0 },
      { member_id: 'b', shares: 0 },
    ]);
    expect(out.every(r => r.amount_cents === 0)).toBe(true);
  });

  it('truncates a fractional share rather than rounding underneath the rounding', () => {
    expect(apportionByShares(300, [
      { member_id: 'a', shares: 1.9 },
      { member_id: 'b', shares: 1 },
    ])).toEqual([
      { member_id: 'a', amount_cents: 150 },
      { member_id: 'b', amount_cents: 150 },
    ]);
  });
});

describe('apportionByWeight divisor', () => {
  // This is the whole reason the divisor is a parameter: a saved 3333/3333/3333
  // rule totals 9,999bp, and dividing by its own sum would renormalize it into
  // a rule nobody agreed to instead of letting the leftover pass fix the gap.
  it('keeps a short percent rule short rather than renormalising it', () => {
    const thirds = [
      { member_id: 'a', weight: 3333 },
      { member_id: 'b', weight: 3333 },
      { member_id: 'c', weight: 3333 },
    ];
    // At $10,000 the two divisors visibly disagree: against TOTAL_BP the rule
    // only claims 99.99% and the largest-remainder pass runs out of members
    // before it runs out of pennies, so 97¢ goes unallocated — which is what a
    // rule that does not add up to 100% MEANS. Dividing by the rule's own sum
    // would hide that by quietly scaling it up to 100%.
    const byTotal = apportionByWeight(1000000, thirds, TOTAL_BP);
    const bySum   = apportionByWeight(1000000, thirds, 9999);
    expect(byTotal.reduce((s, r) => s + r.amount_cents, 0)).toBe(999903);
    expect(bySum.reduce((s, r) => s + r.amount_cents, 0)).toBe(1000000);
    // Unreachable from the UI: validateCategoryPercents refuses to save a rule
    // that is not exactly 100%, so only a hand-written /api/db row gets here.
    expect(validateCategoryPercents(thirds.map(t => ({ percent_bp: t.weight })))).toBe(false);
  });
});

describe('computeSplits – shares and percent', () => {
  it('defaults a member with no share entry to one share', () => {
    expect(computeSplits(9000, ['a', 'b', 'c'], 'shares', {}, { a: 2 })).toEqual([
      { member_id: 'a', amount_cents: 4500 },
      { member_id: 'b', amount_cents: 2250 },
      { member_id: 'c', amount_cents: 2250 },
    ]);
  });

  it('reads percent weights as basis points', () => {
    expect(computeSplits(10000, ['a', 'b'], 'percent', {}, { a: 7000, b: 3000 })).toEqual([
      { member_id: 'a', amount_cents: 7000 },
      { member_id: 'b', amount_cents: 3000 },
    ]);
  });

  it('gives a percent split with no weights nothing, rather than an even split', () => {
    // Silently evening out an unfilled percent form would record a split the
    // member never chose and never saw in the preview.
    expect(computeSplits(10000, ['a', 'b'], 'percent')).toEqual([
      { member_id: 'a', amount_cents: 0 },
      { member_id: 'b', amount_cents: 0 },
    ]);
  });

  it('leaves equal and custom exactly as they were', () => {
    expect(computeSplits(1000, ['a', 'b', 'c'], 'equal')[0].amount_cents).toBe(334);
    expect(computeSplits(1000, ['a'], 'custom', { a: 1000 })).toEqual([
      { member_id: 'a', amount_cents: 1000 },
    ]);
  });
});

describe('computeSplitsWithCategory – method reporting', () => {
  it('names the per-expense method instead of collapsing it to custom', () => {
    expect(computeSplitsWithCategory(9000, ['a', 'b'], 'shares', {}, [], 'food', { a: 2 }).source)
      .toBe('shares');
    expect(computeSplitsWithCategory(9000, ['a', 'b'], 'percent', {}, [], 'food', { a: 10000 }).source)
      .toBe('percent');
  });

  it('still lets the saved category rule win, but only for an equal split', () => {
    const rules = [
      { category: 'health', member_id: 'a', percent_bp: 6000 },
      { category: 'health', member_id: 'b', percent_bp: 4000 },
    ];
    expect(computeSplitsWithCategory(10000, ['a', 'b'], 'equal', {}, rules, 'health').source)
      .toBe('category');
    // A member who picked shares on this one expense means it, so the saved
    // rule must not quietly overrule the choice they just made.
    const shares = computeSplitsWithCategory(10000, ['a', 'b'], 'shares', {}, rules, 'health', { a: 1, b: 1 });
    expect(shares.source).toBe('shares');
    expect(shares.splits[0].amount_cents).toBe(5000);
  });
});

describe('validateShares', () => {
  it('accepts whole shares with at least one positive', () => {
    expect(validateShares({ a: 2, b: 0 }, ['a', 'b'])).toBe(true);
    expect(validateShares({}, ['a', 'b'])).toBe(true);   // both default to 1
  });
  it('rejects an all-zero, negative, fractional or absurd set', () => {
    expect(validateShares({ a: 0, b: 0 }, ['a', 'b'])).toBe(false);
    expect(validateShares({ a: -1, b: 1 }, ['a', 'b'])).toBe(false);
    expect(validateShares({ a: 1.5, b: 1 }, ['a', 'b'])).toBe(false);
    expect(validateShares({ a: 100000, b: 1 }, ['a', 'b'])).toBe(false);
  });
});

describe('splitTypeLabel', () => {
  it('labels every method the form offers', () => {
    for (const m of SPLIT_METHODS) expect(splitTypeLabel(m.id)).toBe(m.label);
  });
  it('reads an unknown or missing stored value as Equal', () => {
    expect(splitTypeLabel(undefined)).toBe('Equal');
    expect(splitTypeLabel('something_else')).toBe('Equal');
  });
});

// ── spending summary ─────────────────────────────────────────────────────────

const SUM_EXPENSES = [
  { id: 'e1', paid_by: 'a', amount_cents: 6000, category: 'food',      date: '2026-09-04' },
  { id: 'e2', paid_by: 'b', amount_cents: 4000, category: 'food',      date: '2026-09-20' },
  { id: 'e3', paid_by: 'a', amount_cents: 9000, category: 'utilities', date: '2026-08-11' },
  { id: 'e4', paid_by: 'a', amount_cents: 1000, category: 'food',      date: '2025-12-31' },
];
const SUM_SPLITS = [
  { expense_id: 'e1', member_id: 'a', amount_cents: 3000 },
  { expense_id: 'e1', member_id: 'b', amount_cents: 3000 },
  { expense_id: 'e2', member_id: 'a', amount_cents: 2000 },
  { expense_id: 'e2', member_id: 'b', amount_cents: 2000 },
  { expense_id: 'e3', member_id: 'a', amount_cents: 4500 },
  { expense_id: 'e3', member_id: 'b', amount_cents: 4500 },
  { expense_id: 'e4', member_id: 'a', amount_cents: 1000 },
];

describe('monthKey / monthLabel / expenseMonths', () => {
  it('takes the month straight off the stored string', () => {
    expect(monthKey('2026-09-04')).toBe('2026-09');
    expect(monthKey('')).toBe(null);
    expect(monthKey(undefined)).toBe(null);
  });
  it('names a month without going through Date, which would shift it west of UTC', () => {
    expect(monthLabel('2026-09')).toBe('September 2026');
    expect(monthLabel('2026-01')).toBe('January 2026');
    expect(monthLabel('2026-12')).toBe('December 2026');
  });
  it('lists the months present, newest first, without repeats', () => {
    expect(expenseMonths(SUM_EXPENSES)).toEqual(['2026-09', '2026-08', '2025-12']);
  });
});

describe('rangeForPeriod', () => {
  it('opens both ends for all time and for anything it does not recognise', () => {
    expect(rangeForPeriod('all')).toEqual({ from: null, to: null });
    expect(rangeForPeriod('month:nonsense')).toEqual({ from: null, to: null });
    expect(rangeForPeriod(undefined)).toEqual({ from: null, to: null });
  });
  it('bounds a month above every day it can contain', () => {
    const { from, to } = rangeForPeriod('month:2026-02');
    expect(from).toBe('2026-02-01');
    expect('2026-02-29' <= to).toBe(true);
    expect('2026-03-01' <= to).toBe(false);
  });
  it('bounds a year the same way', () => {
    const { from, to } = rangeForPeriod('year:2026');
    expect(expensesInRange(SUM_EXPENSES, { from, to }).map(e => e.id)).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('summarize', () => {
  it('totals a month by category', () => {
    const s = summarize(SUM_EXPENSES, SUM_SPLITS, rangeForPeriod('month:2026-09'));
    expect(s.total_cents).toBe(10000);
    expect(s.count).toBe(2);
    expect(s.byCategory).toEqual([{ category: 'food', total_cents: 10000, count: 2 }]);
  });

  it('ranks categories by spend', () => {
    const s = summarize(SUM_EXPENSES, SUM_SPLITS, rangeForPeriod('year:2026'));
    expect(s.byCategory.map(c => c.category)).toEqual(['food', 'utilities']);
  });

  it('reports what each person paid and what they owed as separate numbers', () => {
    const s = summarize(SUM_EXPENSES, SUM_SPLITS, rangeForPeriod('year:2026'));
    const a = s.byMember.find(r => r.member_id === 'a');
    const b = s.byMember.find(r => r.member_id === 'b');
    expect(a).toMatchObject({ paid_cents: 15000, share_cents: 9500, net_cents: 5500 });
    expect(b).toMatchObject({ paid_cents: 4000, share_cents: 9500, net_cents: -5500 });
  });

  it('counts only the splits of expenses inside the range', () => {
    // e4's split sits outside 2026 and must not inflate a's share.
    const s = summarize(SUM_EXPENSES, SUM_SPLITS, rangeForPeriod('year:2026'));
    expect(s.byMember.find(r => r.member_id === 'a').share_cents).toBe(9500);
  });

  it('nets to zero across everybody, because every cent was split', () => {
    const s = summarize(SUM_EXPENSES, SUM_SPLITS, {});
    expect(s.byMember.reduce((t, r) => t + r.net_cents, 0)).toBe(0);
  });

  it('is empty rather than undefined for a period with nothing in it', () => {
    const s = summarize(SUM_EXPENSES, SUM_SPLITS, rangeForPeriod('month:2019-01'));
    expect(s).toMatchObject({ total_cents: 0, count: 0, byCategory: [], byMember: [] });
  });
});

// ── pay-via links ────────────────────────────────────────────────────────────

describe('normalizeHandle / displayHandle', () => {
  it('drops the sigil people type out of habit', () => {
    expect(normalizeHandle('@sam')).toBe('sam');
    expect(normalizeHandle('  $sam ')).toBe('sam');
    expect(normalizeHandle(null)).toBe('');
  });
  it('puts the sigil back for display, per service', () => {
    expect(displayHandle('venmo', 'sam')).toBe('@sam');
    expect(displayHandle('cashapp', 'sam')).toBe('$sam');
    expect(displayHandle('paypal', 'sam')).toBe('sam');
  });
});

describe('validateHandle', () => {
  it('accepts an ordinary username, an email and a phone', () => {
    expect(validateHandle('venmo', '@sam-mayer').ok).toBe(true);
    expect(validateHandle('zelle', 'sam@example.com').ok).toBe(true);
    expect(validateHandle('zelle', '+15551234567').ok).toBe(true);
  });
  it('refuses anything that could change where the link points', () => {
    for (const bad of ['sam/../evil', 'evil.com/sam', 'a b', 'javascript:alert(1)', '']) {
      expect(validateHandle('venmo', bad).ok, bad).toBe(false);
    }
  });
  it('refuses a service nobody offers', () => {
    expect(validateHandle('not-a-service', 'sam').ok).toBe(false);
  });
});

describe('payLink', () => {
  it('builds a prefilled https link for the services that take one', () => {
    expect(payLink('venmo', '@sam', 14000, 'Rent'))
      .toBe('https://venmo.com/sam?txn=pay&amount=140.00&note=Rent');
    expect(payLink('paypal', 'sam', 14000)).toBe('https://paypal.me/sam/140.00');
    expect(payLink('cashapp', '$sam', 14000)).toBe('https://cash.app/$sam/140.00');
  });

  it('omits the amount rather than sending a zero or a negative', () => {
    expect(payLink('venmo', 'sam', 0)).toBe('https://venmo.com/sam?txn=pay');
    expect(payLink('paypal', 'sam', -500)).toBe('https://paypal.me/sam');
  });

  it('returns nothing for services with no web hand-off', () => {
    expect(payLink('zelle', 'sam@example.com', 100)).toBe(null);
    expect(payLink('other', 'sam', 100)).toBe(null);
  });

  it('refuses a handle that could change the scheme or escape the path segment', () => {
    for (const bad of ['/evil', '..%2Fevil', 'javascript:alert(1)', 'a b', '//evil.com', '..', '-']) {
      expect(payLink('venmo', bad, 100), bad).toBe(null);
      expect(validateHandle('venmo', bad).ok, bad).toBe(false);
    }
  });

  it('keeps the host fixed even for a handle that looks like a domain', () => {
    // 'evil.com' is a legal username string, so it is not rejected — it simply
    // lands on venmo.com/evil.com. The host is a literal in payLink and no
    // stored value reaches it, which is the property that matters.
    const url = new URL(payLink('venmo', 'evil.com', 100));
    expect(url.origin).toBe('https://venmo.com');
    expect(url.pathname).toBe('/evil.com');
  });

  it('keeps the whole handle inside one path segment', () => {
    const url = new URL(payLink('venmo', 'sam.o_1-2', 100));
    expect(url.origin).toBe('https://venmo.com');
    expect(url.pathname).toBe('/sam.o_1-2');
  });

  it('trims a long note rather than building an unbounded URL', () => {
    const url = payLink('venmo', 'sam', 100, 'x'.repeat(500));
    expect(new URL(url).searchParams.get('note').length).toBe(200);
  });
});

describe('handleMap / paymentServiceFor', () => {
  it('keys saved handles by member', () => {
    const map = handleMap([{ member_id: 'a', service: 'venmo', handle: 'sam' }]);
    expect(map.get('a')).toEqual({ service: 'venmo', handle: 'sam' });
    expect(map.get('zzz')).toBe(undefined);
    expect(handleMap(undefined).size).toBe(0);
  });
  it('falls back to the catch-all service rather than returning undefined', () => {
    expect(paymentServiceFor('nope').id).toBe('other');
    expect(PAYMENT_SERVICES.some(s => s.id === 'venmo')).toBe(true);
  });
});

// ── review regressions ───────────────────────────────────────────────────────

describe('validateCategoryPercents rejects a negative share', () => {
  it('refuses -10/110 even though it sums to exactly 100%', () => {
    // The sum check alone let this through, and apportioning it wrote a
    // NEGATIVE amount_cents, which computeBalances reads as the payer owing
    // money to the member whose share it was.
    expect(validateCategoryPercents([{ percent_bp: -5000 }, { percent_bp: 15000 }])).toBe(false);
  });

  it('refuses a non-numeric share rather than coercing it to zero', () => {
    expect(validateCategoryPercents([{ percent_bp: 'x' }, { percent_bp: 10000 }])).toBe(false);
    expect(validateCategoryPercents([{ percent_bp: NaN }, { percent_bp: 10000 }])).toBe(false);
  });

  it('still accepts an ordinary rule', () => {
    expect(validateCategoryPercents([{ percent_bp: 6000 }, { percent_bp: 4000 }])).toBe(true);
    expect(validateCategoryPercents([{ percent_bp: 0 }, { percent_bp: 10000 }])).toBe(true);
  });

  it('is what stands between a saved rule and a negative split', () => {
    const bad = [{ member_id: 'a', percent_bp: -5000 }, { member_id: 'b', percent_bp: 15000 }];
    expect(validateCategoryPercents(bad)).toBe(false);
    // …because the apportionment itself will faithfully produce one.
    expect(apportionByPercent(10000, bad)[0].amount_cents).toBeLessThan(0);
  });
});

describe('an expense records the rule that actually split it', () => {
  const rules = [
    { category: 'health', member_id: 'a', percent_bp: 7000 },
    { category: 'health', member_id: 'b', percent_bp: 3000 },
  ];

  it('reports source "category" when the saved rule wins over an equal split', () => {
    const out = computeSplitsWithCategory(10000, ['a', 'b'], 'equal', {}, rules, 'health');
    expect(out.source).toBe(CATEGORY_RULE_SPLIT);
    expect(out.splits).toEqual([
      { member_id: 'a', amount_cents: 7000 },
      { member_id: 'b', amount_cents: 3000 },
    ]);
  });

  it('labels that stored value as the rule it was, not as Equal', () => {
    // Storing the form's setting instead of the source made a 70/30 expense
    // print "Equal" in the detail row and in the exported ledger.
    expect(splitTypeLabel(CATEGORY_RULE_SPLIT)).toBe('Category rule');
    expect(splitTypeLabel(CATEGORY_RULE_SPLIT)).not.toBe('Equal');
  });

  it('still reports "equal" when no rule covers the category', () => {
    expect(computeSplitsWithCategory(10000, ['a', 'b'], 'equal', {}, rules, 'food').source).toBe('equal');
  });
});

describe('sharesError names the rule that was broken', () => {
  it('distinguishes an empty set from an over-large one', () => {
    expect(sharesError({ a: 0, b: 0 }, ['a', 'b'])).toMatch(/at least one/i);
    expect(sharesError({ a: MAX_SHARES + 1, b: 1 }, ['a', 'b'])).toContain(String(MAX_SHARES));
    expect(sharesError({ a: 1.5, b: 1 }, ['a', 'b'])).toMatch(/whole numbers/i);
    expect(sharesError({ a: -1, b: 1 }, ['a', 'b'])).toMatch(/whole numbers/i);
  });

  it('says nothing when the shares are usable', () => {
    expect(sharesError({ a: 2, b: 1 }, ['a', 'b'])).toBe(null);
    expect(sharesError({}, ['a', 'b'])).toBe(null);
  });

  it('agrees with validateShares in both directions', () => {
    for (const w of [{ a: 0, b: 0 }, { a: 1001, b: 1 }, { a: 1.5 }, { a: 2, b: 1 }, {}]) {
      expect(validateShares(w, ['a', 'b'])).toBe(sharesError(w, ['a', 'b']) === null);
    }
  });
});

describe('a percent set that is not 100% has no per-member answer', () => {
  it('apportions a number that looks authoritative and is not', () => {
    // 1% / 0% of $100. The largest-remainder pass gives out at most one penny
    // per member, so 99 dollars simply vanish. The form must not preview this;
    // this test pins WHY, so the gate in updateWeightTotals is not "cleaned up".
    const out = computeSplits(10000, ['a', 'b'], 'percent', {}, { a: 100 });
    expect(out.reduce((s, r) => s + r.amount_cents, 0)).not.toBe(10000);
    expect(validateCategoryPercents([{ percent_bp: 100 }, { percent_bp: 0 }])).toBe(false);
  });
});
