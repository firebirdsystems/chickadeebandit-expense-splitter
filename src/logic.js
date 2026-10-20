/**
 * Pure business logic for the Expense Splitter app.
 * No DOM, no browser globals — safe to import in Node.js tests.
 */

export const CATEGORIES = [
  { id: 'food',          label: 'Food & Dining',  glyph: 'cloche' },
  { id: 'transport',     label: 'Transport',       glyph: 'car' },
  { id: 'utilities',     label: 'Utilities',       glyph: 'lightbulb' },
  { id: 'household',     label: 'Household',       glyph: 'house' },
  { id: 'entertainment', label: 'Entertainment',   glyph: 'film' },
  { id: 'shopping',      label: 'Shopping',        glyph: 'shop-bag' },
  { id: 'travel',        label: 'Travel',          glyph: 'plane' },
  { id: 'health',        label: 'Health',          glyph: 'pill' },
  { id: 'other',         label: 'Other',           glyph: 'box' },
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
 * 'equal'   — distributes evenly; early members absorb remainder pennies.
 * 'shares'  — weights from `weights` (memberId → whole shares, default 1).
 * 'percent' — weights from `weights` (memberId → basis points, must total 100%).
 * 'custom'  — uses caller-provided customAmounts map (memberId → cents).
 *
 * `weights` is a fifth positional parameter rather than a field on
 * customAmounts because the two carry different units — cents in one, shares or
 * basis points in the other — and a single map would make the unit depend on a
 * sibling argument.
 */
export function computeSplits(amountCents, memberIds, splitType, customAmounts = {}, weights = {}) {
  if (memberIds.length === 0) return [];

  if (splitType === 'equal') {
    const base      = Math.floor(amountCents / memberIds.length);
    const remainder = amountCents - base * memberIds.length;
    return memberIds.map((id, i) => ({
      member_id:    id,
      amount_cents: base + (i < remainder ? 1 : 0),
    }));
  }

  if (splitType === 'shares') {
    return apportionByShares(
      amountCents,
      memberIds.map(id => ({ member_id: id, shares: weights[id] ?? 1 })),
    );
  }

  if (splitType === 'percent') {
    return apportionByPercent(
      amountCents,
      memberIds.map(id => ({ member_id: id, percent_bp: weights[id] ?? 0 })),
    );
  }

  return memberIds.map(id => ({
    member_id:    id,
    amount_cents: customAmounts[id] ?? 0,
  }));
}

/**
 * The split methods the Add-Expense form offers, in the order it shows them.
 * `equal` leads because it is the default and the saved per-category rule only
 * applies there — see computeSplitsWithCategory.
 */
/** A split produced by the saved per-category rule rather than by a method the
 *  member picked on the form. Stored in `split_type` so the expense can say
 *  which rule it came from; never offered as a choice, because it is only
 *  reachable by leaving the form on Equal. */
export const CATEGORY_RULE_SPLIT = 'category';

export const SPLIT_METHODS = [
  { id: 'equal',   label: 'Equal',   symbol: '=' },
  { id: 'shares',  label: 'Shares',  symbol: ':' },
  { id: 'percent', label: 'Percent', symbol: '%' },
  { id: 'custom',  label: 'Exact',   symbol: '\u2260' },
];

/** Human label for a stored `split_type`, including rows written before a
 *  method existed and rows whose value nobody here recognises. */
export function splitTypeLabel(id) {
  if (id === CATEGORY_RULE_SPLIT) return 'Category rule';
  return SPLIT_METHODS.find(m => m.id === id)?.label ?? 'Equal';
}

/** The largest share a single member may hold. Bounded so one absurd weight
 *  cannot squeeze everybody else's share to zero pennies. */
export const MAX_SHARES = 1000;

/**
 * Why a share set is unusable, or null when it is fine. Returns the reason
 * rather than a bare false so the form can say which rule was broken — "give
 * at least one person a share" is a lie when the real problem is a weight of
 * 1,001, and the member has no way to discover the ceiling otherwise.
 */
export function sharesError(weights, memberIds) {
  const values = memberIds.map(id => weights[id] ?? 1);
  if (values.some(v => !Number.isInteger(v) || v < 0)) return 'Shares must be whole numbers.';
  if (values.some(v => v > MAX_SHARES)) return `No one can hold more than ${MAX_SHARES} shares.`;
  if (!values.some(v => v > 0)) return 'Give at least one person a share.';
  return null;
}

/** True when whole shares are usable: every weight is a non-negative integer
 *  within the ceiling, and at least one is positive so the divisor is not zero. */
export function validateShares(weights, memberIds) {
  return sharesError(weights, memberIds) === null;
}

// ── Per-category split defaults ─────────────────────────────────────────────
//
// Percentages are stored in BASIS POINTS (10000 = 100%) so a three-way split
// is exact (3333/3333/3334) instead of drifting through float percentages.
// Every function here works in integer cents and basis points; no floats touch
// a money value.

export const TOTAL_BP = 10000;

/**
 * A stored basis-point value as a number, or NaN when it is not one.
 *
 * `Number()` alone is too generous for a value coming back out of the database:
 * it reads null, undefined-shaped blanks and '' as a confident 0, so a row with
 * no percentage at all becomes a deliberate 0% and the rule around it validates.
 * Blank means "no answer", which is not the same as "no share", and the
 * difference decides whether a saved rule applies to somebody's money or the
 * app falls back to an even split.
 *
 * Strings that do hold a number still convert, because whether D1 hands back a
 * number or its text depends on how the row was written, and a rule that worked
 * yesterday must not stop applying over that.
 */
export function toBasisPoints(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}

/**
 * Basis points per member for a category, from saved category_splits rows.
 * Returns null when the category has no saved default (caller falls back to an
 * even split) or when the saved rows don't cover exactly `memberIds`, which
 * happens after a member is added or removed — a stale partial rule must not
 * silently reallocate someone's share.
 */
export function splitPercentsForCategory(categorySplits, category, memberIds) {
  const rows = (categorySplits ?? []).filter(r => r.category === category);
  if (rows.length === 0) return null;

  // `Number(x) || 0` here USED to turn every unparseable value into a clean
  // zero, which then sailed through the validator: a rule of "not-a-number" and
  // 10000 read as 0% / 100% and was applied to real expenses. Keep the raw
  // conversion — NaN included — and let the validator reject it.
  const byMember = new Map();
  for (const r of rows) byMember.set(r.member_id, toBasisPoints(r.percent_bp));

  if (byMember.size !== memberIds.length) return null;
  if (!memberIds.every(id => byMember.has(id))) return null;

  const percents = memberIds.map(id => ({ member_id: id, percent_bp: byMember.get(id) }));

  // The SAME validator the form runs, not just a total. A stored -5000/15000
  // pair sums to exactly 10000 and passes a total check, then apportions a
  // NEGATIVE share — a credit nobody granted, landing straight in the balances.
  // These rows come back from the database, where any adult can write one by
  // hand through /api/db, so the rule the form enforces on the way in has to
  // hold again on the way out. A rule that fails it is treated the way a stale
  // partial rule already is: null, and the caller falls back to an even split.
  if (!validateCategoryPercents(percents)) return null;

  return percents;
}

/**
 * Apportion `amountCents` by basis points, in whole cents that sum EXACTLY to
 * the total. Largest-remainder: floor everyone, then hand the leftover pennies
 * to whoever was rounded down hardest (ties break toward the earlier member, so
 * the result is deterministic and testable).
 */
export function apportionByPercent(amountCents, percents) {
  if (!percents || percents.length === 0) return [];
  return apportionByWeight(
    amountCents,
    percents.map(p => ({ member_id: p.member_id, weight: Number(p.percent_bp) || 0 })),
    TOTAL_BP,
  );
}

/**
 * The apportionment itself, over arbitrary integer weights.
 *
 * `divisor` is passed in rather than derived from the weights, and that is the
 * whole reason this is a separate parameter: a saved category rule of
 * 3333/3333/3333 sums to 9,999 basis points, not 10,000. Dividing by TOTAL_BP
 * puts the missing hundredth of a percent into the leftover pool, where the
 * largest-remainder pass hands it to somebody; dividing by 9,999 would silently
 * renormalize the rule into something the household never agreed to. Shares
 * have no such canonical whole, so they pass their own sum.
 *
 * Weights must be integers — `exact % divisor` is only exact for integers, and
 * a fractional share would put a rounding error underneath the rounding fix.
 */
export function apportionByWeight(amountCents, weights, divisor) {
  if (!weights || weights.length === 0) return [];
  const zero = () => weights.map(w => ({ member_id: w.member_id, amount_cents: 0 }));
  if (!(divisor > 0)) return zero();
  // Nobody holding a share means nobody is owed anything. Without this the
  // largest-remainder pass below still has the whole amount as leftover and
  // hands a penny to each member in turn, so an unfilled percent form previewed
  // as "1¢ each" rather than as the empty split it is.
  if (weights.every(w => !(w.weight > 0))) return zero();

  const scaled = weights.map((w, i) => {
    const exact = amountCents * w.weight;
    return { i, member_id: w.member_id, base: Math.floor(exact / divisor), rem: exact % divisor };
  });

  let leftover = amountCents - scaled.reduce((s, x) => s + x.base, 0);
  const order = [...scaled].sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; k < order.length && leftover > 0; k++, leftover--) order[k].base += 1;

  return scaled.map(x => ({ member_id: x.member_id, amount_cents: x.base }));
}

/**
 * Split by shares — "two parts to us, one to each kid" — which is the unequal
 * mode people reach for when a percentage would mean doing arithmetic first.
 * Shares are whole counts; the divisor is their sum, so 2:1:1 is exactly
 * a half, a quarter and a quarter with the pennies settled the same way
 * every other mode settles them.
 */
export function apportionByShares(amountCents, shares) {
  if (!shares || shares.length === 0) return [];
  const rows = shares.map(s => ({
    member_id: s.member_id,
    weight: Math.max(0, Math.trunc(Number(s.shares) || 0)),
  }));
  return apportionByWeight(amountCents, rows, rows.reduce((s, r) => s + r.weight, 0));
}

/**
 * Split amounts for a new expense, preferring the category's saved default.
 * Returns { splits, source } where source is 'category' | 'equal' | 'custom' —
 * the UI shows which rule was applied so a surprising number is explainable.
 */
export function computeSplitsWithCategory(
  amountCents, memberIds, splitType, customAmounts = {}, categorySplits = [], category = null,
  weights = {},
) {
  if (splitType === 'equal' && category) {
    const percents = splitPercentsForCategory(categorySplits, category, memberIds);
    if (percents) return { splits: apportionByPercent(amountCents, percents), source: 'category' };
  }
  return {
    splits: computeSplits(amountCents, memberIds, splitType, customAmounts, weights),
    // A per-expense method is its own explanation, so it names itself rather
    // than collapsing into 'custom' — the form prints this back to the member
    // and "Using the saved rule" versus "By shares" are different claims.
    source: splitType === 'equal' ? 'equal' : splitType,
  };
}

/**
 * Returns true if basis points sum to exactly 100% AND no share is negative.
 *
 * The sum alone is not enough: -10% / 110% totals 10,000bp and would apportion
 * a NEGATIVE amount_cents to one member, which `computeBalances` then reads as
 * that member being owed money by the person who paid. The negative check lives
 * here rather than at the two input sites because this is the function both the
 * per-expense percent form and the saved per-category rule already call, and a
 * guard on one input is a guard the other does not have.
 */
export function validateCategoryPercents(percents) {
  const rows = percents ?? [];
  // Integer, not merely finite. Basis points are whole by definition (10000 =
  // 100%), and a fractional one is either a bug upstream or a hand-written row
  // — both of which apportion pennies nobody can account for.
  if (rows.some(p => !Number.isInteger(toBasisPoints(p.percent_bp)) || toBasisPoints(p.percent_bp) < 0)) {
    return false;
  }
  return rows.reduce((s, p) => s + toBasisPoints(p.percent_bp), 0) === TOTAL_BP;
}

// ── Reimbursement requests ──────────────────────────────────────────────────

/**
 * Effective status of a reimbursement request, merging the party_scoped terms
 * row with its endpoint_only agreement row. Mirrors the CASE the hub docs
 * recommend: terminal states on the request win, then the derived lock.
 */
export function reimbursementStatus(request, agreement) {
  if (request.status === 'cancelled' || request.status === 'settled') return request.status;
  return agreement?.status === 'locked' ? 'locked' : 'pending';
}

/**
 * The terms a request stands for. The hub records them with the first
 * confirmation (manifest agreements.snapshot_columns) and locks on what it
 * recorded, whatever the request row says by then — so once either party has
 * confirmed, the recorded terms are the ones to show and to act on, and the
 * request row is only where they came from. `changed` says the row no longer
 * reads the same. Before anyone confirms there is only the row.
 */
export function reimbursementTerms(request, agreement) {
  const live = { amount_cents: request.amount_cents, note: request.note ?? null };
  const confirmed = !!(agreement?.requester_agreed || agreement?.payer_agreed);
  if (!confirmed) return { ...live, recorded: false, changed: false };
  // A confirmation older than recorded terms carries none: the row is all
  // there is to show, and nothing says it is what was confirmed.
  if (agreement.amount_cents == null) return { ...live, recorded: false, changed: true };
  return {
    amount_cents: agreement.amount_cents, note: agreement.note ?? null, recorded: true,
    changed: agreement.amount_cents !== request.amount_cents || (agreement.note ?? '') !== (request.note ?? ''),
  };
}

/**
 * Validate a reimbursement request before writing it.
 * Amounts arrive as integer cents; anything else is a bug upstream, so reject
 * rather than coerce.
 */
export function validateReimbursement(req) {
  if (!req.payer_id) return { ok: false, error: 'Choose who owes you.' };
  if (req.payer_id === req.requester_id) {
    return { ok: false, error: "You can't request money from yourself." };
  }
  if (!Number.isInteger(req.amount_cents) || req.amount_cents <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' };
  }
  if (req.amount_cents > 100_000_000) return { ok: false, error: 'That amount looks too large.' };
  return { ok: true };
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

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`). The
 * category and the note are in here alongside the description, so "groceries
 * tesco" narrows to one expense rather than matching nothing.
 */
export function searchableFields(expense) {
  return [expense.description, expense.category, expense.note];
}

// ── Spending summary ────────────────────────────────────────────────────────
//
// Every number here is derived from rows the app has already loaded, so the
// summary costs no extra read. It deliberately ignores settlements: a payment
// between two members moves money that was already spent, and counting it again
// would make "what did we spend on food" depend on who has paid whom back.

/** The 'YYYY-MM' an expense belongs to, or null for a row with no usable date. */
export function monthKey(isoDate) {
  return /^\d{4}-\d{2}/.test(isoDate ?? '') ? isoDate.slice(0, 7) : null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '2026-09' → 'September 2026'. Built from the string, never from a Date:
 *  `new Date('2026-09')` is parsed as UTC midnight and renders as August in
 *  every timezone west of Greenwich. */
export function monthLabel(key) {
  const [y, m] = (key ?? '').split('-');
  const name = MONTH_NAMES[Number(m) - 1];
  return name ? `${name} ${y}` : (key ?? '');
}

/** Distinct 'YYYY-MM' keys present in the expense list, newest first. */
export function expenseMonths(expenses) {
  const seen = new Set();
  for (const e of expenses ?? []) {
    const k = monthKey(e.date);
    if (k) seen.add(k);
  }
  return [...seen].sort().reverse();
}

/**
 * The inclusive [from, to] date bounds a period selector stands for.
 * `period` is 'all', 'month:YYYY-MM', or 'year:YYYY'. Bounds are plain
 * YYYY-MM-DD strings compared lexically, which is exactly how the stored
 * `date` column sorts, so no Date arithmetic is involved and no timezone can
 * move a boundary. A month's upper bound is '-32' rather than a real last day:
 * it is above every valid day in the month and below the next month's first,
 * which is all a string comparison needs.
 */
export function rangeForPeriod(period) {
  if (typeof period !== 'string' || period === 'all') return { from: null, to: null };
  const [kind, value] = period.split(':');
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(value)) return { from: `${value}-01`, to: `${value}-32` };
  if (kind === 'year'  && /^\d{4}$/.test(value))       return { from: `${value}-01-01`, to: `${value}-12-32` };
  return { from: null, to: null };
}

/** Expenses whose `date` falls inside an inclusive range; null bounds are open. */
export function expensesInRange(expenses, { from = null, to = null } = {}) {
  return (expenses ?? []).filter(e => {
    if (!e.date) return from === null && to === null;
    if (from !== null && e.date < from) return false;
    if (to !== null && e.date > to) return false;
    return true;
  });
}

/**
 * Totals for a period: overall, by category, and per member.
 *
 * Per member there are two different true numbers and the UI shows both —
 * `paid_cents` is what left that person's pocket, `share_cents` is what they
 * were allocated. The gap between them is the balance, and showing only one is
 * how "I paid for everything" and "I owed for everything" both sound right.
 */
export function summarize(expenses, splits, range = {}) {
  const inRange = expensesInRange(expenses, range);
  const ids = new Set(inRange.map(e => e.id));

  let total = 0;
  const byCategory = new Map();
  const byMember = new Map();
  const member = (id) => {
    let row = byMember.get(id);
    if (!row) { row = { member_id: id, paid_cents: 0, share_cents: 0 }; byMember.set(id, row); }
    return row;
  };

  for (const e of inRange) {
    const cents = Number(e.amount_cents) || 0;
    total += cents;
    const cat = byCategory.get(e.category) ?? { category: e.category, total_cents: 0, count: 0 };
    cat.total_cents += cents;
    cat.count += 1;
    byCategory.set(e.category, cat);
    member(e.paid_by).paid_cents += cents;
  }

  for (const s of splits ?? []) {
    if (!ids.has(s.expense_id)) continue;
    member(s.member_id).share_cents += Number(s.amount_cents) || 0;
  }

  return {
    total_cents: total,
    count: inRange.length,
    byCategory: [...byCategory.values()].sort((a, b) => b.total_cents - a.total_cents),
    byMember: [...byMember.values()]
      .map(r => ({ ...r, net_cents: r.paid_cents - r.share_cents }))
      .sort((a, b) => b.paid_cents - a.paid_cents),
  };
}

// ── Pay-via links ───────────────────────────────────────────────────────────
//
// "Settle up" records that a payment happened; it has never been able to make
// one happen. A saved handle closes that gap with a link, and the link is
// always the service's https form rather than its venmo://-style scheme: the
// app runs in a sandboxed cross-origin iframe, and an https URL opened in a new
// tab hands off to the installed app on a phone and to the website everywhere
// else, while a custom scheme is a dead click on a laptop.

/**
 * `url_handle` splits the list in two, and everything downstream reads it
 * rather than re-listing the services:
 *
 *  - TRUE — the handle becomes a path segment in a real URL (payLink builds
 *    one), so it has to survive being put there: no slash, no colon, no space,
 *    nothing that could change which host is addressed.
 *  - FALSE — there is no link to build. Zelle is bank-by-bank and 'other' is
 *    whatever the two of them agreed, so the handle is only ever shown to a
 *    person to read. Holding those to URL-path rules rejected the exact values
 *    the hints ask for: a Zelle phone number ('+1 (555) 123-4567' has spaces
 *    and parentheses) and an answer like 'Cash or check'.
 */
export const PAYMENT_SERVICES = [
  { id: 'venmo',   label: 'Venmo',    display_prefix: '@', url_handle: true,  hint: 'Your Venmo username, without the @' },
  { id: 'paypal',  label: 'PayPal',   display_prefix: '',  url_handle: true,  hint: 'Your PayPal.Me name' },
  { id: 'cashapp', label: 'Cash App', display_prefix: '$', url_handle: true,  hint: 'Your Cashtag, without the $' },
  { id: 'zelle',   label: 'Zelle',    display_prefix: '',  url_handle: false, hint: 'The phone number or email on your Zelle' },
  { id: 'other',   label: 'Other',    display_prefix: '',  url_handle: false, hint: 'However you want to be paid' },
];

export function paymentServiceFor(id) {
  return PAYMENT_SERVICES.find(s => s.id === id) ?? PAYMENT_SERVICES[PAYMENT_SERVICES.length - 1];
}

/**
 * Strips the sigil people type out of habit, so '@sam' and 'sam' save alike.
 *
 * Only for a username. Pass the service and a free-text handle keeps its
 * leading character, because '$20 in cash' is an answer, not a Cashtag with a
 * stray dollar on it.
 */
export function normalizeHandle(raw, service) {
  const text = String(raw ?? '').trim();
  if (service !== undefined && !paymentServiceFor(service).url_handle) return text;
  return text.replace(/^[@$]+/, '');
}

/** A handle safe to put in a URL path. Deliberately narrow: no slash, no colon,
 *  no whitespace, nothing that could change which host or scheme is addressed
 *  even before encodeURIComponent runs. Zelle takes an email or phone, so '@'
 *  and '+' are in the set. */
const HANDLE_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
/** …and must actually name somebody: '..' and '--' pass the character class but
 *  are path noise, not usernames. */
const HANDLE_HAS_NAME_RE = /[A-Za-z0-9]/;

/** A free-text handle is read by a person, not parsed, so the only limits are
 *  a length the settle-up card can show and the absence of control characters,
 *  which no keyboard produces and which would render as nothing. */
export const FREE_TEXT_HANDLE_MAX = 64;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

export function validateHandle(service, raw) {
  // Checked FIRST: the service decides which rules the handle is held to, so
  // an unknown one cannot be reported as a bad username.
  if (!PAYMENT_SERVICES.some(s => s.id === service)) {
    return { ok: false, error: 'Choose a payment service.' };
  }
  const handle = normalizeHandle(raw, service);
  if (!handle) return { ok: false, error: 'Enter your username.' };
  if (!HANDLE_HAS_NAME_RE.test(handle)) {
    return { ok: false, error: 'That needs at least one letter or number.' };
  }
  if (paymentServiceFor(service).url_handle) {
    if (!HANDLE_RE.test(handle)) {
      return { ok: false, error: 'Use letters, numbers and . _ - + @ only.' };
    }
    return { ok: true, handle };
  }
  if (handle.length > FREE_TEXT_HANDLE_MAX) {
    return { ok: false, error: `Keep that under ${FREE_TEXT_HANDLE_MAX} characters.` };
  }
  if (CONTROL_RE.test(handle)) {
    return { ok: false, error: 'Remove any special characters.' };
  }
  return { ok: true, handle };
}

/** The handle as a person would write it — '@sam', '$sam', 'sam@x.com'. */
export function displayHandle(service, handle) {
  return paymentServiceFor(service).display_prefix + normalizeHandle(handle, service);
}

/**
 * A URL that opens the payer's app pre-filled, or null when the service has no
 * web hand-off (Zelle is bank-by-bank; 'other' is free text). A null return is
 * not a failure — the caller shows the handle to copy instead.
 *
 * The scheme and host are literals here and the handle is percent-encoded into
 * a single path segment, so a handle out of the database can never redirect the
 * link somewhere else even if it reached the row past `validateHandle`.
 */
export function payLink(service, handle, amountCents = 0, note = '') {
  // The same `url_handle` flag validateHandle reads: a service with no link to
  // build returns null here BEFORE the path-safety check, so a perfectly valid
  // Zelle phone number is "no link", never "bad handle".
  if (!paymentServiceFor(service).url_handle) return null;
  const clean = normalizeHandle(handle, service);
  if (!clean || !HANDLE_RE.test(clean) || !HANDLE_HAS_NAME_RE.test(clean)) return null;
  const seg = encodeURIComponent(clean);
  const amount = Number.isFinite(amountCents) && amountCents > 0
    ? (amountCents / 100).toFixed(2)
    : null;

  if (service === 'venmo') {
    const params = new URLSearchParams({ txn: 'pay' });
    if (amount) params.set('amount', amount);
    if (note) params.set('note', note.slice(0, 200));
    return `https://venmo.com/${seg}?${params.toString()}`;
  }
  if (service === 'paypal')  return `https://paypal.me/${seg}${amount ? '/' + amount : ''}`;
  if (service === 'cashapp') return `https://cash.app/$${seg}${amount ? '/' + amount : ''}`;
  return null;
}

/** member_id → { service, handle } for the rows the app loaded. */
export function handleMap(rows) {
  return new Map((rows ?? []).map(r => [r.member_id, { service: r.service, handle: r.handle }]));
}

/**
 * The line a failed write shows ("Refused, gone, or failed" in the app-template guide):
 * "try again" only when retrying can work. `thing` and `action` are the app's own nouns
 * ("connection", "save the connection"). `found` is the caller's re-read after a write that
 * changed nothing (or a 404/409): false = the row is gone, true = it is there in another
 * state. A `forUser` error keeps the message the app wrote for it. Never shows hub text.
 */
export function failureLine(e, { action, thing, found } = {}) {
  if (e?.forUser) return e.message;
  if (isDuplicate(e)) return `That ${thing} already exists.`;
  if (e?.status === 403) return `You don’t have permission to ${action}.`;
  if (e?.status === 507) return "The household’s storage is full — free up space first.";
  if (found === false || (found === undefined && e?.status === 404)) return `This ${thing} has been removed.`;
  if (found === true || e?.status === 409 || e?.status === 404) return `This ${thing} was changed by someone else — check it first.`;
  return `Couldn’t ${action} — try again.`;
}

/**
 * "Retry after a lost response" (app-template guide): whether a failed write's answer leaves
 * its outcome unknown — no status, a 400, or a 5xx other than 507 — so the page must re-read
 * by its pinned id or stamp before saying anything. A refusal the hub named is known. A
 * `UNIQUE_CONSTRAINT` answer is a 400 too: a retry of a create that landed collides on its
 * own pinned id, so it is read back as well; only finding the pinned id says it landed.
 */
export function outcomeUnknown(e) {
  if (e?.forUser) return false;
  if (isDuplicate(e)) return true;
  const s = e?.status;
  return s == null || s === 400 || (s >= 500 && s !== 507);
}

/**
 * What a guarded write with a pinned id/stamp did, decided from the re-read that follows a
 * write that changed nothing (`conflict`: `changed: 0` or a batch's 409) or an unknown outcome.
 *   reread      — the re-read succeeded
 *   landed      — the re-read finds the row carrying THIS attempt's pinned id/stamp
 *   found       — the row is still there (undefined: that part of the read is unknown)
 *   parentFound — the row's container is still loaded (false: it went with it)
 * Returns "landed" (run the success path once), "failed" (unknown outcome, not found: the
 * failure line, pin kept), "unknown" (a conflict the re-read could not explain: the plain line,
 * pin kept), or a refusal — "parent-removed" / "removed" / "changed" (pin forgotten).
 */
export function pinnedWriteOutcome({ conflict, reread, landed, found, parentFound = true }) {
  if (reread && landed) return "landed";
  if (!conflict) return "failed";
  if (!reread) return "unknown";
  if (!parentFound) return "parent-removed";
  if (found === undefined) return "unknown";
  return found ? "changed" : "removed";
}

// ── Repeating expenses ──────────────────────────────────────────────────────
//
// A repeating expense is a TEMPLATE row (`recurring_expenses`). Each time one
// comes due, the page posts it as an ordinary expense plus its splits, so
// balances, settlements, reimbursements, reports and the receipt column all
// treat an occurrence exactly like a hand-entered expense. Nothing on the hub
// runs a schedule: an adult opening the app posts whatever has come due since
// the last open, dated the day it was due, not the day it was noticed.
//
// Every date here is a household-local 'YYYY-MM-DD' string (hubToday), and
// the arithmetic is done on calendar fields through Date.UTC, never on a local
// Date, so no timezone or DST change can move an occurrence by a day.

export const CADENCES = [
  { id: 'weekly',  label: 'Weekly',  every: 'Every week' },
  { id: 'monthly', label: 'Monthly', every: 'Every month' },
  { id: 'yearly',  label: 'Yearly',  every: 'Every year' },
];

export function cadenceFor(id) {
  return CADENCES.find(c => c.id === id) ?? null;
}

/** Who hears about an upcoming occurrence: the payer alone, the whole
 *  household (which also puts it on the household calendar), or nobody. */
export const REMIND_SCOPES = [
  { id: 'payer',     label: 'Remind the payer' },
  { id: 'household', label: 'Remind everyone and show on the calendar' },
  { id: 'off',       label: 'No reminder' },
];

/** At most this many occurrences are posted per run. 288 covers five
 *  templates each backfilled with a year of weekly dates (53), the most the
 *  form lets one template reach back. Anything past it posts on the page's
 *  next check (the run does not count the day as done). */
export const MAX_POSTS_PER_RUN = 288;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** { y, m, d } for a real calendar date, or null. '2026-02-30' is null. */
export function parseIsoDate(s) {
  const match = ISO_DATE.exec(typeof s === 'string' ? s : '');
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

function isoDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days in month `m` (1-12) of year `y`. */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The occurrence after `date`.
 *
 * `anchorDay` is the day of the month the expense is really due. It is kept
 * apart from the date because the date gets clamped: rent due on the 31st
 * falls on 30 April and 28 February, and stepping from the clamped date would
 * leave it on the 28th for ever after. With the anchor it returns to the 31st
 * in March. A yearly expense anchored on 29 February lands on the 28th in
 * common years and on the 29th again in leap years.
 */
export function nextOccurrence(date, cadence, anchorDay) {
  const p = parseIsoDate(date);
  if (!p) return null;
  const anchor = Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : p.d;
  if (cadence === 'weekly') {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 7));
    return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  let y = p.y, m = p.m;
  if (cadence === 'monthly') {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  } else if (cadence === 'yearly') {
    y += 1;
  } else {
    return null;
  }
  return isoDate(y, m, Math.min(anchor, daysInMonth(y, m)));
}

function anchorOf(template) {
  const n = Number(template?.anchor_day);
  return Number.isInteger(n) ? n : undefined;
}

/** True once the next occurrence falls after the template's end date. */
export function templateEnded(template) {
  return !!template?.end_date && !!template.next_due_date && template.next_due_date > template.end_date;
}

/**
 * The occurrences of `template` that are due on or before `today`, oldest
 * first, each with the date the template moves on to once it is posted.
 * Empty for a paused or ended template. Stops at `limit`.
 */
export function dueOccurrences(template, today, limit = MAX_POSTS_PER_RUN) {
  if (!template || Number(template.active) !== 1 || !parseIsoDate(today)) return [];
  const end = template.end_date || null;
  const out = [];
  let date = template.next_due_date;
  while (out.length < limit && parseIsoDate(date) && date <= today && (!end || date <= end)) {
    const next = nextOccurrence(date, template.cadence, anchorOf(template));
    // Defensive: a step that does not move forward would loop for ever.
    if (!next || next <= date) break;
    out.push({ date, next });
    date = next;
  }
  return out;
}

/**
 * Where a resumed template picks up: its first occurrence on or after today.
 * Pausing means the occurrences in between were skipped, so resuming must not
 * post them all at once. Unchanged when the next occurrence is still ahead.
 */
export function resumeDate(template, today) {
  let date = template?.next_due_date;
  if (!parseIsoDate(date) || !parseIsoDate(today)) return date ?? null;
  // Bounded: twenty years of weeks, far past any real pause.
  for (let i = 0; i < 1100 && date < today; i++) {
    const next = nextOccurrence(date, template.cadence, anchorOf(template));
    if (!next || next <= date) break;
    date = next;
  }
  return date;
}

/**
 * The two reminder columns the hub's date_reminders protocol reads, derived
 * from the template. `remind_scope` is the household's choice and is never
 * rewritten. `remind` is the protocol's on/off switch and `remind_to` its
 * audience column ('household' rows are emailed to everyone and projected onto
 * the household calendar). A paused or ended template is switched off and
 * narrowed to the payer, so the calendar never shows an occurrence that is not
 * going to be posted. So is a HELD one (templateProblem): every write passes
 * whether it is held, so no pause, resume or edit can switch a held
 * template's reminders back on.
 */
export function reminderColumns(template, held = false) {
  const live = Number(template?.active) === 1 && !templateEnded(template) && !held;
  const scope = template?.remind_scope;
  return {
    remind: live && scope !== 'off' ? 1 : 0,
    remind_to: live && scope === 'household' ? 'household' : 'payer',
  };
}

export function parseJsonField(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** The member ids a template splits between. */
export function templateMembers(template) {
  const ids = parseJsonField(template?.split_members, []);
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [];
}

/**
 * The splits one occurrence of `template` posts, or null when they cannot be
 * computed honestly. The saved category rule is applied at posting time, the
 * same as for an expense added by hand on Equal, so changing a rule changes
 * the occurrences posted after it.
 */
export function occurrenceSplits(template, categorySplits = []) {
  const amount = Number(template?.amount_cents);
  const ids = templateMembers(template);
  if (!Number.isInteger(amount) || amount <= 0 || ids.length === 0) return null;
  const weights = parseJsonField(template.split_weights, {});
  const type = template.split_type;
  if (!SPLIT_METHODS.some(m => m.id === type)) return null;
  const custom = type === 'custom' ? weights : {};
  const result = computeSplitsWithCategory(
    amount, ids, type, custom, categorySplits, template.category, type === 'custom' ? {} : weights);
  const total = result.splits.reduce((s, x) => s + x.amount_cents, 0);
  if (total !== amount || result.splits.some(x => !Number.isInteger(x.amount_cents) || x.amount_cents < 0)) return null;
  return result;
}

/**
 * Why a template cannot post right now, in words for the card, or null.
 * `memberIds` is the current roster. A template naming someone who has left
 * is held rather than posted: it would put a share on a person who can no
 * longer see or settle it.
 */
export function templateProblem(template, memberIds, categorySplits = []) {
  const roster = memberIds instanceof Set ? memberIds : new Set(memberIds ?? []);
  if (!cadenceFor(template?.cadence) || !parseIsoDate(template?.next_due_date)) {
    return 'This repeating expense has an unreadable schedule. Edit it to fix it.';
  }
  if (!roster.has(template.paid_by)) return 'The person who pays this is no longer a member. Edit it to choose someone else.';
  const ids = templateMembers(template);
  if (ids.some(id => !roster.has(id))) return 'Someone in this split is no longer a member. Edit it to update the split.';
  if (!occurrenceSplits(template, categorySplits)) return 'This split no longer adds up. Edit it to fix it.';
  return null;
}

/**
 * The one transaction that posts an occurrence.
 *
 * The template's UPDATE goes first and carries the guard: it moves
 * next_due_date on only from the date being posted, and only while the row
 * is still the version this page read (`updated_at`). Two adults opening the
 * app together both try to post the same date; one UPDATE matches, the
 * other changes nothing, and its unmet `requireChanges` rolls its whole batch
 * back, the expense and splits with it. The stamp also refuses a page holding
 * a template someone has since edited, so it never posts the old amount,
 * payer or split. The UNIQUE index on (recurring_id, occurrence_date) is the
 * backstop under both. The hub's reminder cron writes only last_reminded_at,
 * so it never moves the stamp.
 *
 * `plan` is null when this date is already posted (the template was moved back
 * onto it by an edit): the template advances and nothing is inserted.
 */
export function occurrenceStatements(template, occurrence, plan, { expenseId, splitIds = [], now }) {
  const advanced = { ...template, next_due_date: occurrence.next };
  const { remind, remind_to } = reminderColumns(advanced);
  const statements = [{
    sql: 'UPDATE app_expense_splitter__recurring_expenses SET next_due_date = ?, remind = ?, remind_to = ?, updated_at = ? WHERE id = ? AND next_due_date = ? AND updated_at = ? AND active = 1',
    params: [occurrence.next, remind, remind_to, now, template.id, occurrence.date, template.updated_at],
    requireChanges: true,
  }];
  if (!plan) return statements;
  statements.push({
    sql: 'INSERT INTO app_expense_splitter__expenses (id, paid_by, amount_cents, description, category, date, split_type, created_at, receipt_file_id, recurring_id, occurrence_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    params: [expenseId, template.paid_by, template.amount_cents, template.description, template.category,
      occurrence.date, plan.source, now, null, template.id, occurrence.date],
  });
  if (plan.splits.length > 0) {
    statements.push({
      sql: `INSERT INTO app_expense_splitter__expense_splits (id, expense_id, member_id, amount_cents) VALUES ${plan.splits.map(() => '(?,?,?,?)').join(',')}`,
      params: plan.splits.flatMap((s, i) => [splitIds[i], expenseId, s.member_id, s.amount_cents]),
    });
  }
  return statements;
}

/** "Every month · next Nov 1" style summary for a template card. */
export function scheduleLabel(template) {
  const cadence = cadenceFor(template?.cadence);
  if (!cadence) return 'Unreadable schedule';
  if (Number(template.active) !== 1) return `${cadence.every} · paused`;
  if (templateEnded(template)) return `${cadence.every} · ended ${fmtDate(template.end_date)}`;
  return `${cadence.every} · next ${fmtDate(template.next_due_date)}`;
}

/** The cadence an edit form opens on. A stored value this app does not know
 *  (a hand-written row) becomes Monthly, which the form then shows and saves,
 *  rather than being written back unchanged behind a dropdown that says
 *  something else. */
export function editableCadence(cadence) {
  return cadenceFor(cadence) ? cadence : 'monthly';
}

/**
 * The anchor day a saved template keeps. An edit that leaves the due date as
 * the form showed it keeps the stored anchor: that date may be clamped to a
 * short month (rent anchored on the 31st showing 30 April), and reading the
 * anchor back off it would move every later occurrence to the 30th for good.
 * A new template, or a date the member changed, anchors on the date's own day.
 * So does any move to or from Weekly: a weekly template's stored anchor is the
 * day of its first date, which says nothing about a month. Monthly and yearly
 * share a day-of-month anchor, so switching between them keeps it.
 */
export function anchorForSave(editing, date, cadence) {
  const parsed = parseIsoDate(date);
  if (!parsed) return null;
  const kept = Number(editing?.anchor_day);
  const sameSchedule = editing && date === editing.next_due_date
    && editing.cadence !== 'weekly' && cadence !== 'weekly';
  if (sameSchedule && Number.isInteger(kept) && kept >= 1 && kept <= 31) return kept;
  return parsed.d;
}

/** The earliest due date the form accepts: one year before `today`. A
 *  first date in the past backfills every occurrence since, so a mistyped
 *  year (2006 for 2026) would otherwise add a thousand weekly expenses. */
export function earliestDueDate(today) {
  const p = parseIsoDate(today);
  if (!p) return null;
  return isoDate(p.y - 1, p.m, Math.min(p.d, daysInMonth(p.y - 1, p.m)));
}

/**
 * Why the repeating form's dates cannot be saved, in words for the form, or
 * null. `today` (household-local) bounds how far back a due date may reach.
 * `stored` is the template being edited, as the form knows it is stored:
 *  - kept exactly as it is, a schedule that cannot post (paused, or ended) is
 *    never refused: fixing the description of an ended template must not
 *    force reviving it.
 *  - a PAUSED template may keep a due date older than the bound: it posts
 *    nothing until resumed, and resuming skips the gap.
 * Anything else that reaches back further than a year is refused: a mistyped
 * year, or an ended template extended from an old date, would backfill every
 * occurrence since.
 */
export function scheduleFormError(start, end, today = null, stored = null) {
  if (!parseIsoDate(start)) return 'Choose the date it is due.';
  if (end && !parseIsoDate(end)) return 'Choose a real end date, or clear it.';
  const paused = stored && Number(stored.active) !== 1;
  const keepsSchedule = stored && start === stored.next_due_date && (end || '') === (stored.end_date || '');
  if (keepsSchedule && (paused || templateEnded(stored))) return null;
  const earliest = earliestDueDate(today);
  if (earliest && start < earliest && !(paused && start === stored.next_due_date)) {
    return 'The due date is more than a year ago. Choose a later one, or add older expenses one at a time.';
  }
  if (end && end < start) return 'The end date is before the due date. Move it later or clear it.';
  return null;
}

/** A guarded write that matched nothing: an unmet `requireChanges` answers 409
 *  ("stale state"). Someone else moved the row first. */
export function isStaleConflict(e) {
  return e?.status === 409 || /stale state/i.test(String(e?.message ?? ''));
}

/** A UNIQUE constraint refused the write: the row it would add is already there. */
export function isDuplicate(e) {
  return e?.code === 'UNIQUE_CONSTRAINT' || /UNIQUE constraint failed/i.test(String(e?.message ?? ''));
}

/** api/db's cap on statements in one batch (MAX_APP_DB_BATCH_STATEMENTS in
 *  hub-contract). */
export const MAX_BATCH_STATEMENTS = 25;

/** Occurrences chained into one transaction. Each takes at most three
 *  statements (advance, expense, splits), so eight fit under the cap. */
export const OCCURRENCES_PER_BATCH = Math.floor(MAX_BATCH_STATEMENTS / 3);

/**
 * A template's due occurrences as transactions of up to OCCURRENCES_PER_BATCH
 * each, so a backlog costs one round trip per eight rather than one per
 * occurrence. The guards chain: each UPDATE moves next_due_date on only from
 * the value and stamp the previous one set, so if another adult posted or
 * edited any of these first, a guard misses and the whole batch rolls back.
 *
 * `isPosted(date)` says the ledger already holds that date (an edit moved the
 * template back onto it); the template then advances past it with no copy.
 * Each batch lists the expenses it adds as `items`.
 */
export function postingBatches(template, occurrences, plan, { isPosted, newId, now }) {
  const batches = [];
  let current = template;
  for (let i = 0; i < occurrences.length; i += OCCURRENCES_PER_BATCH) {
    const statements = [];
    const items = [];
    for (const occurrence of occurrences.slice(i, i + OCCURRENCES_PER_BATCH)) {
      const already = isPosted(occurrence.date);
      const expenseId = newId();
      statements.push(...occurrenceStatements(current, occurrence, already ? null : plan, {
        expenseId, splitIds: plan.splits.map(() => newId()), now,
      }));
      if (!already) items.push({ date: occurrence.date, expenseId });
      // The next step guards on what this one wrote.
      current = { ...current, next_due_date: occurrence.next, updated_at: now };
    }
    batches.push({ statements, items, next_due_date: current.next_due_date });
  }
  return batches;
}

/**
 * The write that brings a template's reminder columns in line with whether it
 * can post. A HELD template (templateProblem: its payer or a split member
 * left, or its split no longer adds up) will not post until something changes,
 * so it must not keep emailing "due in three days" or sit on the household
 * calendar. A hold can also clear without an edit (a member rejoins, a
 * category rule is fixed), and then its reminders come back. Null when the
 * columns already match. remind_scope, the household's choice, is never
 * touched.
 *
 * Guarded on the stamp (a row edited since changes nothing), but it does NOT
 * move it: updated_at versions the terms
 * and the schedule, and these two columns are derived from them. Bumping it
 * would refuse every other adult's open edit form as "changed by someone else"
 * whenever a page load flipped a hold, though no term changed.
 */
export function reminderSyncStatement(template, held) {
  const want = reminderColumns(template, held);
  if (Number(template?.remind) === want.remind && template?.remind_to === want.remind_to) return null;
  // No requireChanges: each sync is best-effort and sent beside others, so a
  // stale guard just changes nothing rather than rolling the rest back.
  return {
    sql: 'UPDATE app_expense_splitter__recurring_expenses SET remind = ?, remind_to = ? WHERE id = ? AND updated_at = ?',
    params: [want.remind, want.remind_to, template.id, template.updated_at],
  };
}

/** "id|date" keys of the occurrences already in the ledger, built once per
 *  posting run so each due date is a lookup rather than a scan. */
export function postedOccurrenceKeys(expenses) {
  const keys = new Set();
  for (const e of expenses ?? []) {
    if (e?.recurring_id && e.occurrence_date) keys.add(`${e.recurring_id}|${e.occurrence_date}`);
  }
  return keys;
}

/** The columns a member sets on the form. Two template rows with the same
 *  terms post the same expenses on the same dates. */
const TEMPLATE_TERMS = [
  'description', 'amount_cents', 'category', 'paid_by', 'split_type', 'split_members',
  'split_weights', 'cadence', 'anchor_day', 'next_due_date', 'end_date', 'remind_scope',
];

/**
 * Whether a stored template holds exactly the terms a save sent. A retried
 * save reuses its pinned stamp, so a matching stamp alone proves only that
 * SOME try of this form landed; if the member changed a field between tries,
 * the row holds the earlier values, and the page must not show the later ones
 * as saved.
 */
export function sameTemplateTerms(stored, sent) {
  if (!stored || !sent) return false;
  return TEMPLATE_TERMS.every(k => String(stored[k] ?? '') === String(sent[k] ?? ''));
}
