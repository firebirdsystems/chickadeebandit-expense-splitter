/**
 * Pure business logic for the Expense Splitter app.
 * No DOM, no browser globals — safe to import in Node.js tests.
 */

export const CATEGORIES = [
  { id: 'food',          label: 'Food & Dining',  icon: '🍔' },
  { id: 'transport',     label: 'Transport',       icon: '🚗' },
  { id: 'utilities',     label: 'Utilities',       icon: '💡' },
  { id: 'household',     label: 'Household',       icon: '🏠' },
  { id: 'entertainment', label: 'Entertainment',   icon: '🎬' },
  { id: 'shopping',      label: 'Shopping',        icon: '🛒' },
  { id: 'travel',        label: 'Travel',          icon: '✈️' },
  { id: 'health',        label: 'Health',          icon: '💊' },
  { id: 'other',         label: 'Other',           icon: '📦' },
];

export function categoryFor(id) {
  return CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

/**
 * Compute net balance for each member from expenses, splits, and settlements.
 * Positive  = this member is owed money (creditor).
 * Negative  = this member owes money (debtor).
 *
 * For each expense split where member_id !== paid_by:
 *   member_id's balance decreases (they owe the payer).
 *   paid_by's balance increases (they are owed).
 * For each settlement (from_id paid to_id):
 *   from_id's balance increases (they've paid off debt).
 *   to_id's balance decreases (they've been paid).
 */
export function computeBalances(expenses, splits, settlements) {
  const balance = {};

  // Group splits by expense once (O(splits)) so the per-expense loop is O(1)
  // lookup instead of re-scanning every split for each expense (was O(n·m)).
  const splitsByExpense = new Map();
  for (const s of splits) {
    let list = splitsByExpense.get(s.expense_id);
    if (!list) { list = []; splitsByExpense.set(s.expense_id, list); }
    list.push(s);
  }

  for (const exp of expenses) {
    const paidBy = exp.paid_by;
    if (balance[paidBy] === undefined) balance[paidBy] = 0;

    const expSplits = splitsByExpense.get(exp.id) ?? [];
    for (const split of expSplits) {
      const mid = split.member_id;
      if (balance[mid] === undefined) balance[mid] = 0;
      if (mid === paidBy) continue;
      balance[mid]    -= split.amount_cents;
      balance[paidBy] += split.amount_cents;
    }
  }

  for (const s of settlements) {
    if (balance[s.from_id] === undefined) balance[s.from_id] = 0;
    if (balance[s.to_id]   === undefined) balance[s.to_id]   = 0;
    balance[s.from_id] += s.amount_cents;
    balance[s.to_id]   -= s.amount_cents;
  }

  return balance;
}

/**
 * Convert a balance map into the minimum number of "A owes B $X" transactions
 * using a greedy creditor/debtor matching algorithm.
 */
export function simplifyDebts(balance) {
  const creditors = [];
  const debtors   = [];

  for (const [id, bal] of Object.entries(balance)) {
    const rounded = Math.round(bal);
    if (rounded >  0) creditors.push({ id, amount: rounded });
    if (rounded < 0) debtors.push({ id, amount: -rounded });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let ci = 0, di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amount = Math.min(c.amount, d.amount);

    if (amount > 0) {
      transactions.push({ from_id: d.id, to_id: c.id, amount_cents: amount });
    }

    c.amount -= amount;
    d.amount -= amount;

    if (c.amount === 0) ci++;
    if (d.amount === 0) di++;
  }

  return transactions;
}

/**
 * Compute split amounts for a new expense.
 * Returns an array of { member_id, amount_cents }.
 *
 * 'equal'  — distributes evenly; early members absorb remainder pennies.
 * 'custom' — uses caller-provided customAmounts map (memberId → cents).
 */
export function computeSplits(amountCents, memberIds, splitType, customAmounts = {}) {
  if (memberIds.length === 0) return [];

  if (splitType === 'equal') {
    const base      = Math.floor(amountCents / memberIds.length);
    const remainder = amountCents - base * memberIds.length;
    return memberIds.map((id, i) => ({
      member_id:    id,
      amount_cents: base + (i < remainder ? 1 : 0),
    }));
  }

  return memberIds.map(id => ({
    member_id:    id,
    amount_cents: customAmounts[id] ?? 0,
  }));
}

/** Returns true if the custom amounts sum exactly to the expense total. */
export function validateCustomSplits(amountCents, customAmounts) {
  const total = Object.values(customAmounts).reduce((s, v) => s + (v || 0), 0);
  return total === amountCents;
}

/** Format cents as "$1,234" (whole) or "$1,234.56" (when cents are non-zero). */
export function fmtSplit(cents) {
  if (cents == null) return '$0';
  const abs = Math.abs(cents);
  const dollars = abs / 100;
  const str = dollars % 1 === 0
    ? dollars.toLocaleString('en-US')
    : dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cents < 0 ? '-$' : '$') + str;
}

/** Format ISO date as "Jun 8" or "Jun 8, 2025" for cross-year dates. */
export function fmtDate(isoDate) {
  if (!isoDate) return '';
  const d    = new Date(isoDate + 'T12:00:00');
  const now  = new Date();
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** Today's date as YYYY-MM-DD. */
export function today() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
