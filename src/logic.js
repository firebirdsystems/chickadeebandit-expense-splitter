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
