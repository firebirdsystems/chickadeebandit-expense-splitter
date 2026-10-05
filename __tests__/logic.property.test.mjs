/**
 * Property-based tests for the money math.
 *
 * logic.test.mjs pins the splits someone thought of — $10 three ways,
 * 3333/3333/3334. These pin what has to hold for EVERY amount, group size and
 * rule, including the stored rules nobody wrote through the form:
 *
 *  - CONSERVATION. A split hands out exactly the expense, to the cent. No
 *    penny is created and none goes missing.
 *  - NO NEGATIVE SHARE. A negative share is a credit: computeBalances reads it
 *    as the payer owing that member money. Nothing a member can save may
 *    produce one.
 *  - FAIRNESS. Nobody is rounded more than a cent away from their exact share,
 *    and a bigger share never pays less than a smaller one.
 *  - ZERO SUM. Balances always net to nothing, and paying the suggested
 *    transfers leaves everyone at exactly zero.
 *
 * The seed is random by default; fast-check prints the failing seed and a
 * shrunk counterexample. Replay with
 *   CB_FC_SEED=<seed> CB_FC_RUNS=1 npx vitest run logic.property
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MAX_SHARES,
  TOTAL_BP,
  apportionByPercent,
  apportionByShares,
  apportionByWeight,
  computeBalances,
  computeSplits,
  computeSplitsWithCategory,
  simplifyDebts,
  splitPercentsForCategory,
  validateCategoryPercents,
  validateCustomSplits,
  validateShares,
} from '../src/logic.js';

const FC = {
  numRuns: Number(process.env.CB_FC_RUNS ?? 300),
  ...(process.env.CB_FC_SEED ? { seed: Number(process.env.CB_FC_SEED) } : {}),
};

// ── Generators ──────────────────────────────────────────────────────────────

/** Up to $10M, the ceiling validateReimbursement enforces — and weighted toward
 *  the small amounts where a stray penny is the whole story. */
const amountArb = fc.oneof(
  fc.integer({ min: 0, max: 200 }),
  fc.integer({ min: 0, max: 1_000_000_000 }),
);

const membersArb = fc.integer({ min: 1, max: 12 }).map(n => Array.from({ length: n }, (_, i) => `m${i + 1}`));

/** `n` whole numbers ≥ 0 that total exactly `total`, built by cutting the range
 *  at random points — so zeros and lopsided rules turn up as often as even ones. */
function partitionArb(n, total) {
  return fc.array(fc.integer({ min: 0, max: total }), { minLength: n - 1, maxLength: n - 1 }).map(cuts => {
    const edges = [0, ...cuts.sort((a, b) => a - b), total];
    return edges.slice(1).map((edge, i) => edge - edges[i]);
  });
}

/** Members plus a valid 100% rule over them, in basis points. */
const percentRuleArb = membersArb.chain(ids =>
  partitionArb(ids.length, TOTAL_BP).map(bps => ({ ids, bps })),
);

/** Members plus whole shares the form would accept (at least one positive). */
const sharesArb = membersArb.chain(ids =>
  fc.array(fc.integer({ min: 0, max: MAX_SHARES }), { minLength: ids.length, maxLength: ids.length })
    .filter(shares => shares.some(s => s > 0))
    .map(shares => ({ ids, shares })),
);

const total = rows => rows.reduce((sum, r) => sum + r.amount_cents, 0);

function expectWholeNonNegativeCents(rows) {
  for (const r of rows) {
    expect(Number.isInteger(r.amount_cents)).toBe(true);
    expect(r.amount_cents).toBeGreaterThanOrEqual(0);
  }
}

// ── Apportionment ───────────────────────────────────────────────────────────

describe('apportionByWeight', () => {
  it('hands out exactly the amount when the weights make up the whole', () => {
    fc.assert(fc.property(amountArb, sharesArb, (amount, { ids, shares }) => {
      const divisor = shares.reduce((s, w) => s + w, 0);
      const rows = apportionByWeight(amount, ids.map((id, i) => ({ member_id: id, weight: shares[i] })), divisor);
      expect(rows.map(r => r.member_id)).toEqual(ids);
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBe(amount);
    }), FC);
  });

  it('rounds nobody more than a cent away from their exact share', () => {
    fc.assert(fc.property(amountArb, sharesArb, (amount, { ids, shares }) => {
      const divisor = shares.reduce((s, w) => s + w, 0);
      const rows = apportionByWeight(amount, ids.map((id, i) => ({ member_id: id, weight: shares[i] })), divisor);
      rows.forEach((r, i) => {
        // Integer arithmetic on both sides: floor ≤ share ≤ ceil of amount·w/divisor.
        expect(r.amount_cents * divisor).toBeGreaterThan(amount * shares[i] - divisor);
        expect(r.amount_cents * divisor).toBeLessThan(amount * shares[i] + divisor);
      });
    }), FC);
  });

  it('never charges a member who holds no share', () => {
    fc.assert(fc.property(amountArb, sharesArb, (amount, { ids, shares }) => {
      const divisor = shares.reduce((s, w) => s + w, 0);
      const rows = apportionByWeight(amount, ids.map((id, i) => ({ member_id: id, weight: shares[i] })), divisor);
      rows.forEach((r, i) => { if (shares[i] === 0) expect(r.amount_cents).toBe(0); });
    }), FC);
  });

  it('never has a bigger share pay less than a smaller one', () => {
    fc.assert(fc.property(amountArb, sharesArb, (amount, { ids, shares }) => {
      const divisor = shares.reduce((s, w) => s + w, 0);
      const rows = apportionByWeight(amount, ids.map((id, i) => ({ member_id: id, weight: shares[i] })), divisor);
      for (let a = 0; a < ids.length; a++) {
        for (let b = 0; b < ids.length; b++) {
          if (shares[a] > shares[b]) expect(rows[a].amount_cents).toBeGreaterThanOrEqual(rows[b].amount_cents);
          if (shares[a] === shares[b]) expect(Math.abs(rows[a].amount_cents - rows[b].amount_cents)).toBeLessThanOrEqual(1);
        }
      }
    }), FC);
  });

  it('never hands out more than the amount when the weights fall short of the whole', () => {
    // An unfinished percent form: 30% + 20% of a bill is not the whole bill, and
    // the preview must not invent the rest.
    fc.assert(fc.property(amountArb, membersArb.chain(ids =>
      fc.array(fc.integer({ min: 0, max: Math.floor(TOTAL_BP / ids.length) }), { minLength: ids.length, maxLength: ids.length })
        .map(bps => ({ ids, bps }))), (amount, { ids, bps }) => {
      const rows = apportionByWeight(amount, ids.map((id, i) => ({ member_id: id, weight: bps[i] })), TOTAL_BP);
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBeLessThanOrEqual(amount);
    }), FC);
  });

  it('charges nobody when the divisor is unusable or nobody holds a share', () => {
    fc.assert(fc.property(amountArb, membersArb, fc.constantFrom(0, -1, NaN, undefined, null), (amount, ids, divisor) => {
      const some = ids.map(id => ({ member_id: id, weight: 1 }));
      const none = ids.map(id => ({ member_id: id, weight: 0 }));
      expect(total(apportionByWeight(amount, some, divisor))).toBe(0);
      expect(total(apportionByWeight(amount, none, TOTAL_BP))).toBe(0);
    }), FC);
  });
});

describe('apportionByShares', () => {
  it('conserves the amount for any shares the form accepts', () => {
    fc.assert(fc.property(amountArb, sharesArb, (amount, { ids, shares }) => {
      const weights = Object.fromEntries(ids.map((id, i) => [id, shares[i]]));
      expect(validateShares(weights, ids)).toBe(true);
      const rows = apportionByShares(amount, ids.map((id, i) => ({ member_id: id, shares: shares[i] })));
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBe(amount);
    }), FC);
  });

  it('gives the same split when every share is multiplied by the same factor', () => {
    // 2:1:1 and 4:2:2 are the same agreement.
    fc.assert(fc.property(amountArb, sharesArb, fc.integer({ min: 2, max: 9 }), (amount, { ids, shares }, k) => {
      const plain = apportionByShares(amount, ids.map((id, i) => ({ member_id: id, shares: shares[i] })));
      const scaled = apportionByShares(amount, ids.map((id, i) => ({ member_id: id, shares: shares[i] * k })));
      expect(scaled).toEqual(plain);
    }), FC);
  });

  it('never produces a negative or fractional share from junk input', () => {
    // Magnitude is bounded on purpose: sharesError caps a share at MAX_SHARES
    // before this runs, and amount × share has to stay an exact integer. What is
    // NOT bounded is the kind of value — negatives, fractions, NaN, text.
    const junk = fc.oneof(
      fc.integer({ min: -50, max: 50 }),
      fc.double({ min: -1e6, max: 1e6, noNaN: false }),
      fc.string(), fc.constant(null), fc.constant(undefined),
    );
    fc.assert(fc.property(amountArb, fc.array(junk, { minLength: 1, maxLength: 8 }), (amount, shares) => {
      const rows = apportionByShares(amount, shares.map((s, i) => ({ member_id: `m${i}`, shares: s })));
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBeLessThanOrEqual(amount);
    }), FC);
  });
});

describe('apportionByPercent', () => {
  it('conserves the amount for any rule the validator accepts', () => {
    fc.assert(fc.property(amountArb, percentRuleArb, (amount, { ids, bps }) => {
      const percents = ids.map((id, i) => ({ member_id: id, percent_bp: bps[i] }));
      expect(validateCategoryPercents(percents)).toBe(true);
      const rows = apportionByPercent(amount, percents);
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBe(amount);
    }), FC);
  });

  it('gives 100% of the bill to the member holding 100%', () => {
    fc.assert(fc.property(amountArb, membersArb, fc.nat(), (amount, ids, pick) => {
      const owner = pick % ids.length;
      const rows = apportionByPercent(amount, ids.map((id, i) => ({ member_id: id, percent_bp: i === owner ? TOTAL_BP : 0 })));
      rows.forEach((r, i) => expect(r.amount_cents).toBe(i === owner ? amount : 0));
    }), FC);
  });
});

// ── The validator is what stands between a stored rule and somebody's money ──

/** A percent_bp cell as it might come back from the database: the form's own
 *  integers, their text, blanks, fractions, negatives and junk. */
const storedBpArb = fc.oneof(
  fc.integer({ min: 0, max: TOTAL_BP }),
  fc.integer({ min: -TOTAL_BP * 2, max: TOTAL_BP * 2 }),
  fc.integer({ min: 0, max: TOTAL_BP }).map(String),
  fc.double({ min: -TOTAL_BP, max: TOTAL_BP, noNaN: true }),
  fc.constantFrom(null, undefined, '', '  ', 'abc', NaN, Infinity, -Infinity, true, false, '1e4', '0x10'),
);

describe('validateCategoryPercents', () => {
  it('accepts exactly the rules that are whole, non-negative and total 100%', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: -TOTAL_BP, max: TOTAL_BP * 2 }), { minLength: 1, maxLength: 8 }), bps => {
      const expected = bps.every(b => b >= 0) && bps.reduce((s, b) => s + b, 0) === TOTAL_BP;
      expect(validateCategoryPercents(bps.map((b, i) => ({ member_id: `m${i}`, percent_bp: b })))).toBe(expected);
    }), FC);
  });

  it('whatever it accepts apportions without a negative share and without losing a cent', () => {
    fc.assert(fc.property(amountArb, fc.array(storedBpArb, { minLength: 1, maxLength: 8 }), (amount, cells) => {
      const percents = cells.map((c, i) => ({ member_id: `m${i}`, percent_bp: c }));
      if (!validateCategoryPercents(percents)) return;
      const rows = apportionByPercent(amount, percents);
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBe(amount);
    }), FC);
  });
});

describe('computeSplitsWithCategory', () => {
  /** Saved rows for one category, written by anyone: possibly for the wrong
   *  members, possibly duplicated, possibly not numbers at all. */
  const savedRowsArb = ids => fc.array(
    fc.record({
      category: fc.constantFrom('groceries', 'rent'),
      member_id: fc.constantFrom(...ids, 'm_gone'),
      percent_bp: storedBpArb,
    }),
    { maxLength: 16 },
  );

  it('an even split conserves the amount and mints no negative share, whatever rule is stored', () => {
    fc.assert(fc.property(amountArb, membersArb.chain(ids => savedRowsArb(ids).map(rows => ({ ids, rows }))), (amount, { ids, rows }) => {
      const { splits, source } = computeSplitsWithCategory(amount, ids, 'equal', {}, rows, 'groceries');
      expect(['category', 'equal']).toContain(source);
      expect(splits.map(s => s.member_id)).toEqual(ids);
      expectWholeNonNegativeCents(splits);
      expect(total(splits)).toBe(amount);
    }), FC);
  });

  it('applies a stored rule only when it covers exactly the current members', () => {
    fc.assert(fc.property(amountArb, percentRuleArb, fc.boolean(), (amount, { ids, bps }, dropOne) => {
      const rows = ids.map((id, i) => ({ category: 'groceries', member_id: id, percent_bp: bps[i] }));
      // A member joined since the rule was saved: it no longer names everyone.
      const members = dropOne ? [...ids, 'm_new'] : ids;
      const { source } = computeSplitsWithCategory(amount, members, 'equal', {}, rows, 'groceries');
      expect(source).toBe(dropOne ? 'equal' : 'category');
      expect(splitPercentsForCategory(rows, 'rent', ids)).toBeNull();
    }), FC);
  });
});

describe('computeSplits', () => {
  it('equal: conserves the amount and no two members differ by more than a cent', () => {
    fc.assert(fc.property(amountArb, membersArb, (amount, ids) => {
      const rows = computeSplits(amount, ids, 'equal');
      expect(rows.map(r => r.member_id)).toEqual(ids);
      expectWholeNonNegativeCents(rows);
      expect(total(rows)).toBe(amount);
      const cents = rows.map(r => r.amount_cents);
      expect(Math.max(...cents) - Math.min(...cents)).toBeLessThanOrEqual(1);
    }), FC);
  });

  it('shares and percent: conserve the amount for any weights the form accepts', () => {
    fc.assert(fc.property(amountArb, sharesArb, (amount, { ids, shares }) => {
      const weights = Object.fromEntries(ids.map((id, i) => [id, shares[i]]));
      expect(total(computeSplits(amount, ids, 'shares', {}, weights))).toBe(amount);
    }), FC);
    fc.assert(fc.property(amountArb, percentRuleArb, (amount, { ids, bps }) => {
      const weights = Object.fromEntries(ids.map((id, i) => [id, bps[i]]));
      expect(total(computeSplits(amount, ids, 'percent', {}, weights))).toBe(amount);
    }), FC);
  });

  it('custom: the validator accepts exactly the amounts that total the expense', () => {
    fc.assert(fc.property(amountArb, membersArb, fc.integer({ min: -3, max: 3 }), (amount, ids, drift) => {
      const exact = computeSplits(amount, ids, 'equal');
      const custom = Object.fromEntries(exact.map(r => [r.member_id, r.amount_cents]));
      custom[ids[0]] += drift;
      expect(validateCustomSplits(amount, custom)).toBe(drift === 0);
      expect(total(computeSplits(amount, ids, 'custom', custom))).toBe(amount + drift);
    }), FC);
  });
});

// ── Balances ────────────────────────────────────────────────────────────────

/** A household ledger: expenses with splits (by any method) and settlements,
 *  all between members of one group. */
const ledgerArb = fc.integer({ min: 2, max: 8 }).chain(n => {
  const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);
  const member = fc.constantFrom(...ids);
  const expense = fc.record({
    paid_by: member,
    amount: fc.integer({ min: 0, max: 5_000_000 }),
    among: fc.subarray(ids, { minLength: 1 }),
    method: fc.constantFrom('equal', 'shares'),
    shares: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: n, maxLength: n }),
  });
  const settlement = fc.record({ from_id: member, to_id: member, amount_cents: fc.integer({ min: 0, max: 5_000_000 }) });
  return fc.record({
    ids: fc.constant(ids),
    expenses: fc.array(expense, { maxLength: 12 }),
    settlements: fc.array(settlement, { maxLength: 6 }),
  });
}).map(({ ids, expenses, settlements }) => {
  const rows = expenses.map((e, i) => ({ id: `e${i}`, paid_by: e.paid_by, amount_cents: e.amount }));
  const splits = expenses.flatMap((e, i) => {
    const weights = Object.fromEntries(ids.map((id, k) => [id, e.shares[k]]));
    return computeSplits(e.amount, e.among, e.method, {}, weights).map(s => ({ ...s, expense_id: `e${i}` }));
  });
  return { ids, expenses: rows, splits, settlements };
});

describe('computeBalances', () => {
  it('always nets to zero', () => {
    fc.assert(fc.property(ledgerArb, ({ expenses, splits, settlements }) => {
      const balance = computeBalances(expenses, splits, settlements);
      expect(Object.values(balance).reduce((s, v) => s + v, 0)).toBe(0);
      for (const v of Object.values(balance)) expect(Number.isInteger(v)).toBe(true);
    }), FC);
  });

  it('does not depend on the order rows arrive in', () => {
    fc.assert(fc.property(ledgerArb, fc.infiniteStream(fc.nat()), ({ expenses, splits, settlements }, rnd) => {
      const shuffle = rows => rows.map(r => [rnd.next().value, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
      expect(computeBalances(shuffle(expenses), shuffle(splits), shuffle(settlements)))
        .toEqual(computeBalances(expenses, splits, settlements));
    }), FC);
  });

  it("a payer's own share costs them nothing extra, and each other share moves exactly its amount", () => {
    fc.assert(fc.property(amountArb, membersArb.filter(ids => ids.length > 1), (amount, ids) => {
      const splits = computeSplits(amount, ids, 'equal').map(s => ({ ...s, expense_id: 'e1' }));
      const balance = computeBalances([{ id: 'e1', paid_by: ids[0] }], splits, []);
      expect(balance[ids[0]]).toBe(amount - splits[0].amount_cents);
      splits.slice(1).forEach(s => expect(balance[s.member_id] + 0).toBe(-s.amount_cents + 0));
    }), FC);
  });

  it('ignores a split whose expense is not in the ledger', () => {
    fc.assert(fc.property(ledgerArb, ({ ids, expenses, splits, settlements }) => {
      const orphan = { expense_id: 'e_deleted', member_id: ids[0], amount_cents: 12_345 };
      expect(computeBalances(expenses, [...splits, orphan], settlements))
        .toEqual(computeBalances(expenses, splits, settlements));
    }), FC);
  });
});

describe('simplifyDebts', () => {
  it('paying the suggested transfers leaves everybody at exactly zero', () => {
    fc.assert(fc.property(ledgerArb, ({ expenses, splits, settlements }) => {
      const transfers = simplifyDebts(computeBalances(expenses, splits, settlements));
      const after = computeBalances(expenses, splits, [...settlements, ...transfers]);
      for (const v of Object.values(after)) expect(v + 0).toBe(0);
    }), FC);
  });

  it('only debtors pay, only creditors are paid, and never more than they owe or are owed', () => {
    fc.assert(fc.property(ledgerArb, ({ expenses, splits, settlements }) => {
      const balance = computeBalances(expenses, splits, settlements);
      const paid = {}, received = {};
      for (const t of simplifyDebts(balance)) {
        expect(Number.isInteger(t.amount_cents)).toBe(true);
        expect(t.amount_cents).toBeGreaterThan(0);
        expect(t.from_id).not.toBe(t.to_id);
        expect(balance[t.from_id]).toBeLessThan(0);
        expect(balance[t.to_id]).toBeGreaterThan(0);
        paid[t.from_id] = (paid[t.from_id] ?? 0) + t.amount_cents;
        received[t.to_id] = (received[t.to_id] ?? 0) + t.amount_cents;
      }
      for (const [id, cents] of Object.entries(paid)) expect(cents).toBe(-balance[id]);
      for (const [id, cents] of Object.entries(received)) expect(cents).toBe(balance[id]);
    }), FC);
  });

  it('needs at most one transfer fewer than the number of people with a balance', () => {
    fc.assert(fc.property(ledgerArb, ({ expenses, splits, settlements }) => {
      const balance = computeBalances(expenses, splits, settlements);
      const unsettled = Object.values(balance).filter(v => v !== 0).length;
      expect(simplifyDebts(balance).length).toBeLessThanOrEqual(Math.max(0, unsettled - 1));
    }), FC);
  });

  it('suggests nothing once everyone is settled', () => {
    fc.assert(fc.property(ledgerArb, ({ expenses, splits, settlements }) => {
      const transfers = simplifyDebts(computeBalances(expenses, splits, settlements));
      expect(simplifyDebts(computeBalances(expenses, splits, [...settlements, ...transfers]))).toEqual([]);
    }), FC);
  });
});
