/**
 * Repeating expenses: the schedule math and the transaction that posts one
 * occurrence.
 *
 * Every "today" here is passed in. Nothing reads the clock, so these say the
 * same thing on any day they run.
 *
 * Property runs follow the package convention:
 *   CB_FC_SEED=<seed> CB_FC_RUNS=1 npx vitest run recurring
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fc from 'fast-check';
import {
  nextOccurrence,
  dueOccurrences,
  resumeDate,
  reminderColumns,
  templateEnded,
  templateProblem,
  occurrenceSplits,
  occurrenceStatements,
  parseIsoDate,
  daysInMonth,
  scheduleLabel,
  parseJsonField,
  templateMembers,
  editableCadence,
  anchorForSave,
  scheduleFormError,
  isStaleConflict,
  isDuplicate,
  postingBatches,
  postedOccurrenceKeys,
  reminderSyncStatement,
  earliestDueDate,
  outcomeUnknown,
  sameTemplateTerms,
  MAX_BATCH_STATEMENTS,
  OCCURRENCES_PER_BATCH,
  MAX_POSTS_PER_RUN,
  REMIND_SCOPES,
} from '../src/logic.js';

const FC = {
  numRuns: Number(process.env.CB_FC_RUNS ?? 300),
  ...(process.env.CB_FC_SEED ? { seed: Number(process.env.CB_FC_SEED) } : {}),
};

const rent = (over = {}) => ({
  id: 'rent',
  description: 'Rent',
  amount_cents: 200000,
  category: 'household',
  paid_by: 'ana',
  split_type: 'equal',
  split_members: JSON.stringify(['ana', 'sam']),
  split_weights: '{}',
  cadence: 'monthly',
  anchor_day: 1,
  next_due_date: '2026-09-01',
  end_date: null,
  active: 1,
  remind_scope: 'payer',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('nextOccurrence', () => {
  it('steps a week, a month and a year', () => {
    expect(nextOccurrence('2026-12-29', 'weekly', 29)).toBe('2027-01-05');
    expect(nextOccurrence('2026-12-01', 'monthly', 1)).toBe('2027-01-01');
    expect(nextOccurrence('2026-03-15', 'yearly', 15)).toBe('2027-03-15');
  });

  it('clamps to short months and returns to the anchor day afterwards', () => {
    expect(nextOccurrence('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(nextOccurrence('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(nextOccurrence('2026-03-31', 'monthly', 31)).toBe('2026-04-30');
    expect(nextOccurrence('2028-01-30', 'monthly', 30)).toBe('2028-02-29');
  });

  it('keeps a leap-day anchor: the 28th in common years, the 29th in leap years', () => {
    expect(nextOccurrence('2028-02-29', 'yearly', 29)).toBe('2029-02-28');
    expect(nextOccurrence('2031-02-28', 'yearly', 29)).toBe('2032-02-29');
  });

  it('falls back to the date\'s own day without a usable anchor', () => {
    expect(nextOccurrence('2026-05-20', 'monthly', undefined)).toBe('2026-06-20');
    expect(nextOccurrence('2026-05-20', 'monthly', 0)).toBe('2026-06-20');
  });

  it('refuses a date or cadence it cannot read', () => {
    expect(nextOccurrence('2026-02-30', 'monthly', 1)).toBeNull();
    expect(nextOccurrence('next tuesday', 'weekly', 1)).toBeNull();
    expect(nextOccurrence('2026-05-01', 'fortnightly', 1)).toBeNull();
  });
});

describe('dueOccurrences', () => {
  it('lists every missed occurrence up to and including today, oldest first', () => {
    expect(dueOccurrences(rent(), '2026-10-19')).toEqual([
      { date: '2026-09-01', next: '2026-10-01' },
      { date: '2026-10-01', next: '2026-11-01' },
    ]);
    expect(dueOccurrences(rent({ next_due_date: '2026-10-19' }), '2026-10-19')).toHaveLength(1);
  });

  it('posts nothing before the due date', () => {
    expect(dueOccurrences(rent({ next_due_date: '2026-10-20' }), '2026-10-19')).toEqual([]);
  });

  it('posts nothing while paused', () => {
    expect(dueOccurrences(rent({ active: 0 }), '2026-10-19')).toEqual([]);
  });

  it('stops at the end date, which may itself post', () => {
    const due = dueOccurrences(rent({ end_date: '2026-10-01' }), '2027-03-01');
    expect(due.map(o => o.date)).toEqual(['2026-09-01', '2026-10-01']);
    expect(dueOccurrences(rent({ end_date: '2026-08-31' }), '2027-03-01')).toEqual([]);
  });

  it('caps one run so a long-unopened weekly expense cannot flood the hub', () => {
    const weekly = rent({ cadence: 'weekly', next_due_date: '2010-01-04' });
    expect(dueOccurrences(weekly, '2026-10-19')).toHaveLength(MAX_POSTS_PER_RUN);
    expect(dueOccurrences(weekly, '2026-10-19', 3)).toHaveLength(3);
  });

  it('chains: each occurrence\'s next is the following one\'s date', () => {
    const due = dueOccurrences(rent({ anchor_day: 31, next_due_date: '2026-01-31' }), '2026-06-30');
    expect(due.map(o => o.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    for (let i = 1; i < due.length; i++) expect(due[i].date).toBe(due[i - 1].next);
  });
});

describe('resumeDate', () => {
  it('skips what fell due while paused and picks up on or after today', () => {
    expect(resumeDate(rent({ next_due_date: '2026-06-01' }), '2026-10-19')).toBe('2026-11-01');
    expect(resumeDate(rent({ next_due_date: '2026-06-01' }), '2026-10-01')).toBe('2026-10-01');
  });

  it('leaves a future next date alone', () => {
    expect(resumeDate(rent({ next_due_date: '2026-12-01' }), '2026-10-19')).toBe('2026-12-01');
  });
});

describe('reminderColumns', () => {
  it('follows the household\'s choice while the template is live', () => {
    expect(reminderColumns(rent())).toEqual({ remind: 1, remind_to: 'payer' });
    expect(reminderColumns(rent({ remind_scope: 'household' }))).toEqual({ remind: 1, remind_to: 'household' });
    expect(reminderColumns(rent({ remind_scope: 'off' }))).toEqual({ remind: 0, remind_to: 'payer' });
  });

  it('switches off and leaves the calendar while held, so no write can wake a held template', () => {
    expect(reminderColumns(rent({ remind_scope: 'household' }), true)).toEqual({ remind: 0, remind_to: 'payer' });
    expect(reminderColumns(rent({ remind_scope: 'household' }), false)).toEqual({ remind: 1, remind_to: 'household' });
  });

  it('switches off and leaves the calendar when paused or ended', () => {
    expect(reminderColumns(rent({ remind_scope: 'household', active: 0 }))).toEqual({ remind: 0, remind_to: 'payer' });
    const ended = rent({ remind_scope: 'household', end_date: '2026-10-01', next_due_date: '2026-11-01' });
    expect(templateEnded(ended)).toBe(true);
    expect(reminderColumns(ended)).toEqual({ remind: 0, remind_to: 'payer' });
  });
});

describe('templateProblem', () => {
  const roster = ['ana', 'sam'];

  it('is null for a template that can post', () => {
    expect(templateProblem(rent(), roster)).toBeNull();
  });

  it('holds a template whose payer or split member has left', () => {
    expect(templateProblem(rent(), ['sam'])).toMatch(/pays this is no longer a member/);
    expect(templateProblem(rent(), ['ana'])).toMatch(/split is no longer a member/);
  });

  it('holds a template whose stored split does not add up', () => {
    const custom = rent({ split_type: 'custom', split_weights: JSON.stringify({ ana: 100000, sam: 50000 }) });
    expect(templateProblem(custom, roster)).toMatch(/no longer adds up/);
  });

  it('holds a template with an unreadable schedule', () => {
    expect(templateProblem(rent({ cadence: 'hourly' }), roster)).toMatch(/unreadable schedule/);
    expect(templateProblem(rent({ next_due_date: '' }), roster)).toMatch(/unreadable schedule/);
  });
});

describe('occurrenceSplits', () => {
  it('splits by the picked method', () => {
    const shares = occurrenceSplits(rent({ split_type: 'shares', split_weights: JSON.stringify({ ana: 3, sam: 1 }) }));
    expect(shares.splits).toEqual([{ member_id: 'ana', amount_cents: 150000 }, { member_id: 'sam', amount_cents: 50000 }]);
    expect(shares.source).toBe('shares');
    const custom = occurrenceSplits(rent({ split_type: 'custom', split_weights: JSON.stringify({ ana: 120000, sam: 80000 }) }));
    expect(custom.splits.map(s => s.amount_cents)).toEqual([120000, 80000]);
  });

  it('follows the category rule on Equal as it stands when the occurrence posts', () => {
    const rule = [
      { category: 'household', member_id: 'ana', percent_bp: 6000 },
      { category: 'household', member_id: 'sam', percent_bp: 4000 },
    ];
    const plan = occurrenceSplits(rent(), rule);
    expect(plan.source).toBe('category');
    expect(plan.splits.map(s => s.amount_cents)).toEqual([120000, 80000]);
    expect(occurrenceSplits(rent()).source).toBe('equal');
  });

  it('refuses a template it cannot split honestly', () => {
    expect(occurrenceSplits(rent({ amount_cents: 0 }))).toBeNull();
    expect(occurrenceSplits(rent({ split_members: '[]' }))).toBeNull();
    expect(occurrenceSplits(rent({ split_members: 'not json' }))).toBeNull();
    expect(occurrenceSplits(rent({ split_type: 'category' }))).toBeNull();
  });
});

describe('occurrenceStatements', () => {
  const occurrence = { date: '2026-10-01', next: '2026-11-01' };
  const ids = { expenseId: 'exp-1', splitIds: ['s-1', 's-2'], now: '2026-10-19T12:00:00.000Z' };

  it('leads with the guarded UPDATE, so a second poster changes nothing and rolls back', () => {
    const [update] = occurrenceStatements(rent(), occurrence, occurrenceSplits(rent()), ids);
    expect(update.requireChanges).toBe(true);
    expect(update.sql).toMatch(/^UPDATE app_expense_splitter__recurring_expenses SET next_due_date = \?/);
    expect(update.sql).toMatch(/WHERE id = \? AND next_due_date = \? AND updated_at = \? AND active = 1$/);
    // The stamp too: a page holding a template someone has since edited must
    // not post the old amount, payer or split.
    expect(update.params.slice(-3)).toEqual(['rent', '2026-10-01', '2026-08-01T00:00:00.000Z']);
    expect(update.params[0]).toBe('2026-11-01');
  });

  it('inserts the expense dated the day it was due, linked to its template and date', () => {
    const [, insert, splits] = occurrenceStatements(rent(), occurrence, occurrenceSplits(rent()), ids);
    expect(insert.requireChanges).toBeUndefined();
    const columns = /\(([^)]*)\) VALUES/.exec(insert.sql)[1].split(',').map(c => c.trim());
    expect(columns).toHaveLength(insert.params.length);
    expect((insert.sql.match(/\?/g) ?? []).length).toBe(insert.params.length);
    const row = Object.fromEntries(columns.map((c, i) => [c, insert.params[i]]));
    expect(row).toMatchObject({
      id: 'exp-1', paid_by: 'ana', amount_cents: 200000, date: '2026-10-01',
      split_type: 'equal', recurring_id: 'rent', occurrence_date: '2026-10-01', receipt_file_id: null,
    });
    expect((splits.sql.match(/\?/g) ?? []).length).toBe(splits.params.length);
    expect(splits.params).toEqual(['s-1', 'exp-1', 'ana', 100000, 's-2', 'exp-1', 'sam', 100000]);
  });

  it('only advances the template for a date already in the ledger', () => {
    const statements = occurrenceStatements(rent(), occurrence, null, ids);
    expect(statements).toHaveLength(1);
    expect(statements[0].requireChanges).toBe(true);
  });

  it('switches reminders off on the step that passes the end date', () => {
    const last = rent({ end_date: '2026-10-01', remind_scope: 'household' });
    const [update] = occurrenceStatements(last, occurrence, occurrenceSplits(last), ids);
    expect(update.params.slice(1, 3)).toEqual([0, 'payer']);
  });
});

describe('scheduleLabel', () => {
  it('says when it next posts, or why it will not', () => {
    expect(scheduleLabel(rent())).toMatch(/^Every month · next /);
    expect(scheduleLabel(rent({ active: 0 }))).toBe('Every month · paused');
    expect(scheduleLabel(rent({ end_date: '2026-08-01' }))).toMatch(/^Every month · ended /);
  });
});

describe('stored-value guards', () => {
  it('reads a JSON field without trusting it', () => {
    expect(parseJsonField('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJsonField('', {})).toEqual({});
    expect(parseJsonField('not json', [])).toEqual([]);
    expect(parseJsonField('42', {})).toEqual({});
    expect(parseJsonField(null, [])).toEqual([]);
  });

  it('keeps only real member ids from the stored split', () => {
    expect(templateMembers({ split_members: JSON.stringify(['ana', '', 7, null, 'sam']) })).toEqual(['ana', 'sam']);
    expect(templateMembers({ split_members: '{"ana":1}' })).toEqual([]);
  });

  it('posts nothing for a today it cannot read', () => {
    expect(dueOccurrences(rent(), '')).toEqual([]);
    expect(dueOccurrences(rent(), '2026-13-01')).toEqual([]);
  });

  it('leaves an unreadable next date alone on resume', () => {
    expect(resumeDate(rent({ next_due_date: 'soon' }), '2026-10-19')).toBe('soon');
  });

  it('splits a percent template exactly, and refuses one that does not total 100%', () => {
    const ok = occurrenceSplits(rent({ split_type: 'percent', split_weights: JSON.stringify({ ana: 3333, sam: 6667 }) }));
    expect(ok.splits.reduce((t, x) => t + x.amount_cents, 0)).toBe(200000);
    expect(ok.source).toBe('percent');
    expect(occurrenceSplits(rent({ split_type: 'percent', split_weights: JSON.stringify({ ana: 5000, sam: 4000 }) }))).toBeNull();
  });

  it('refuses a template whose amount is not whole cents', () => {
    expect(occurrenceSplits(rent({ amount_cents: 100.5 }))).toBeNull();
    expect(occurrenceSplits(rent({ amount_cents: '200000' }))).not.toBeNull();
  });
});

describe('editing a repeating expense', () => {
  it('keeps the stored anchor when the due date is left as the form showed it', () => {
    // Rent anchored on the 31st, sitting on a clamped 30 April.
    const clamped = rent({ anchor_day: 31, next_due_date: '2026-04-30' });
    expect(anchorForSave(clamped, '2026-04-30', 'monthly')).toBe(31);
    expect(nextOccurrence('2026-04-30', 'monthly', anchorForSave(clamped, '2026-04-30', 'monthly'))).toBe('2026-05-31');
    const leap = rent({ cadence: 'yearly', anchor_day: 29, next_due_date: '2027-02-28' });
    expect(anchorForSave(leap, '2027-02-28', 'yearly')).toBe(29);
  });

  it('anchors on the new day when the member changes the date, and on the date for a new template', () => {
    expect(anchorForSave(rent({ anchor_day: 31, next_due_date: '2026-04-30' }), '2026-05-15', 'monthly')).toBe(15);
    expect(anchorForSave(null, '2026-01-31', 'monthly')).toBe(31);
    expect(anchorForSave(rent({ anchor_day: 'x', next_due_date: '2026-04-30' }), '2026-04-30', 'monthly')).toBe(30);
    expect(anchorForSave(null, 'soon', 'monthly')).toBeNull();
  });

  it('re-anchors when the cadence changes, since a weekly anchor says nothing about a month', () => {
    // Created weekly on the 1st, now sitting on the 22nd, switched to monthly.
    const weekly = rent({ cadence: 'weekly', anchor_day: 1, next_due_date: '2026-10-22' });
    expect(anchorForSave(weekly, '2026-10-22', 'monthly')).toBe(22);
    expect(nextOccurrence('2026-10-22', 'monthly', anchorForSave(weekly, '2026-10-22', 'monthly'))).toBe('2026-11-22');
    // Monthly and yearly share a day-of-month anchor, so switching keeps it.
    expect(anchorForSave(rent({ cadence: 'monthly', anchor_day: 31, next_due_date: '2026-04-30' }), '2026-04-30', 'yearly')).toBe(31);
    // Leaving weekly re-anchors too: its stored day is the first date's, not this one's.
    expect(anchorForSave(rent({ cadence: 'weekly', anchor_day: 3, next_due_date: '2026-04-30' }), '2026-04-30', 'weekly')).toBe(30);
    expect(anchorForSave(weekly, '2026-10-22', 'weekly')).toBe(22);
  });

  it('opens an unknown stored cadence as Monthly, so saving writes a real one', () => {
    expect(editableCadence('biweekly')).toBe('monthly');
    expect(editableCadence('')).toBe('monthly');
    expect(editableCadence('yearly')).toBe('yearly');
  });

  it('says why the dates cannot be saved, including an ended template\'s', () => {
    expect(scheduleFormError('2026-10-01', '')).toBeNull();
    expect(scheduleFormError('2026-10-01', '2026-10-01')).toBeNull();
    expect(scheduleFormError('2027-01-31', '2026-12-31')).toMatch(/end date is before the due date/);
    expect(scheduleFormError('', '')).toMatch(/Choose the date/);
    expect(scheduleFormError('2026-10-01', '2026-02-30')).toMatch(/real end date/);
  });
});

describe('reminderSyncStatement', () => {
  it('silences a held template, guarded on its stamp without moving it, leaving the household\'s choice alone', () => {
    const st = reminderSyncStatement(rent({ remind: 1, remind_to: 'household', remind_scope: 'household' }), true);
    // Best-effort and sent beside others: a stale guard changes nothing, it
    // never rolls the other syncs back.
    expect(st.requireChanges).toBeUndefined();
    expect(st.sql).toMatch(/SET remind = \?, remind_to = \? WHERE id = \? AND updated_at = \?$/);
    // Derived columns only: other adults' open edit forms keep a valid stamp.
    expect(st.sql).not.toMatch(/SET[^W]*updated_at/);
    expect(st.sql).not.toContain('remind_scope');
    expect(st.params).toEqual([0, 'payer', 'rent', '2026-08-01T00:00:00.000Z']);
  });

  it('turns reminders back on once a hold clears without an edit', () => {
    const silenced = rent({ remind: 0, remind_to: 'payer', remind_scope: 'household' });
    expect(reminderSyncStatement(silenced, false).params.slice(0, 2)).toEqual([1, 'household']);
  });

  it('writes nothing when the columns already match', () => {
    expect(reminderSyncStatement(rent({ remind: 0, remind_to: 'payer' }), true)).toBeNull();
    expect(reminderSyncStatement(rent({ remind: 1, remind_to: 'payer', remind_scope: 'payer' }), false)).toBeNull();
    // Paused stays silent whether or not it is held.
    expect(reminderSyncStatement(rent({ active: 0, remind: 0, remind_to: 'payer', remind_scope: 'household' }), false)).toBeNull();
  });
});

describe('sameTemplateTerms', () => {
  it('matches a stored row to the terms a save sent, whatever type the hub returned', () => {
    const sent = rent({ end_date: null });
    expect(sameTemplateTerms({ ...sent, amount_cents: '200000', anchor_day: '1', end_date: null }, sent)).toBe(true);
    expect(sameTemplateTerms({ ...sent, end_date: '' }, sent)).toBe(true);
  });

  it('tells an earlier try of the same form from this one', () => {
    expect(sameTemplateTerms(rent({ amount_cents: 10000 }), rent({ amount_cents: 12000 }))).toBe(false);
    expect(sameTemplateTerms(rent(), rent({ remind_scope: 'off' }))).toBe(false);
    // Stamps and bookkeeping are not terms.
    expect(sameTemplateTerms(rent({ updated_at: 'a', remind: 0 }), rent({ updated_at: 'b', remind: 1 }))).toBe(true);
    expect(sameTemplateTerms(null, rent())).toBe(false);
  });
});

describe('the batch cap matches the hub', () => {
  // The SDK does not export the cap, so the app keeps a copy. With a hub
  // checkout beside the apps folder (as preflight expects), hold the copy to
  // the hub's own constant, so a lowered cap fails here rather than refusing
  // every backlog in production.
  const core = join(dirname(fileURLToPath(import.meta.url)), '../../../chickadeebandit/packages/hub-contract/src/manifest/core.ts');
  it.skipIf(!existsSync(core))('equals MAX_APP_DB_BATCH_STATEMENTS in hub-contract', () => {
    const m = /export const MAX_APP_DB_BATCH_STATEMENTS = (\d+);/.exec(readFileSync(core, 'utf-8'));
    expect(m, 'MAX_APP_DB_BATCH_STATEMENTS not found in hub-contract').toBeTruthy();
    expect(MAX_BATCH_STATEMENTS).toBe(Number(m[1]));
  });
});

describe('how far back a repeating expense may start', () => {
  it('is one year before today, clamped for a leap day', () => {
    expect(earliestDueDate('2026-10-19')).toBe('2025-10-19');
    expect(earliestDueDate('2028-02-29')).toBe('2027-02-28');
    expect(earliestDueDate('')).toBeNull();
  });

  it('refuses a mistyped year that would backfill hundreds of expenses', () => {
    expect(scheduleFormError('2006-11-01', '', '2026-10-19')).toMatch(/more than a year ago/);
    expect(scheduleFormError('2025-10-19', '', '2026-10-19')).toBeNull();
    expect(scheduleFormError('2099-01-01', '', '2026-10-19')).toBeNull();
    // Without a today the bound is skipped rather than guessed.
    expect(scheduleFormError('2006-11-01', '')).toBeNull();
  });

  it('lets a paused template keep a stored date older than a year, but not move a date there', () => {
    // Paused fourteen months ago; editing only the amount must stay possible.
    const paused = rent({ active: 0, next_due_date: '2025-08-01' });
    expect(scheduleFormError('2025-08-01', '', '2026-10-19', paused)).toBeNull();
    expect(scheduleFormError('2025-07-01', '', '2026-10-19', paused)).toMatch(/more than a year ago/);
  });

  it('gives a live template no such exemption, so extending one from an old date cannot backfill years', () => {
    const live = rent({ active: 1, next_due_date: '2024-02-01', end_date: '2024-01-15' });
    // Ended and kept exactly as it is: fixing its description must not force reviving it.
    expect(scheduleFormError('2024-02-01', '2024-01-15', '2026-10-19', live)).toBeNull();
    // Extended (end moved or cleared) from the old date: refused.
    expect(scheduleFormError('2024-02-01', '', '2026-10-19', live)).toMatch(/more than a year ago/);
    expect(scheduleFormError('2024-02-01', '2099-01-01', '2026-10-19', live)).toMatch(/more than a year ago/);
  });

  it('lets an ended template be edited without reviving it, and asks for a fix only when its dates change', () => {
    const ended = rent({ next_due_date: '2026-10-01', end_date: '2026-09-30' });
    expect(scheduleFormError('2026-10-01', '2026-09-30', '2026-10-19', ended)).toBeNull();
    expect(scheduleFormError('2026-10-05', '2026-09-30', '2026-10-19', ended)).toMatch(/end date is before/);
  });

  it('lets one run post the largest backfill the form allows for five templates', () => {
    // A year of weekly dates, the most the bound admits for one template.
    const weekly = rent({ cadence: 'weekly', next_due_date: earliestDueDate('2026-10-19') });
    expect(dueOccurrences(weekly, '2026-10-19', 1000).length * 5).toBeLessThanOrEqual(MAX_POSTS_PER_RUN);
  });
});

describe('telling a race from a failure', () => {
  it('reads an unmet guard as a conflict', () => {
    expect(isStaleConflict({ status: 409 })).toBe(true);
    expect(isStaleConflict({ message: 'Stale state claim' })).toBe(true);
    expect(isStaleConflict({ status: 500 })).toBe(false);
  });

  it('treats a duplicate on a pinned id as an unknown outcome to re-read, never a refusal', () => {
    // A retried save whose first try landed collides on its own pinned id; the
    // re-read must decide, or a second click would save a second template.
    expect(outcomeUnknown({ code: 'UNIQUE_CONSTRAINT', status: 400 })).toBe(true);
  });

  it('reads the UNIQUE backstop as a duplicate', () => {
    expect(isDuplicate({ code: 'UNIQUE_CONSTRAINT', status: 400 })).toBe(true);
    expect(isDuplicate({ message: 'UNIQUE constraint failed: x.y' })).toBe(true);
    expect(isDuplicate({ status: 400 })).toBe(false);
    expect(isDuplicate(null)).toBe(false);
  });
});

describe('postingBatches', () => {
  let n = 0;
  const opts = (posted = []) => ({ isPosted: d => posted.includes(d), newId: () => `id-${++n}`, now: '2026-10-19T12:00:00.000Z' });
  const weekly = rent({ cadence: 'weekly', next_due_date: '2026-01-05' });

  it('chains up to eight occurrences per transaction, under the hub\'s statement cap', () => {
    expect(OCCURRENCES_PER_BATCH * 3).toBeLessThanOrEqual(MAX_BATCH_STATEMENTS);
    const due = dueOccurrences(weekly, '2026-10-19');
    const batches = postingBatches(weekly, due, occurrenceSplits(weekly), opts());
    expect(batches).toHaveLength(Math.ceil(due.length / OCCURRENCES_PER_BATCH));
    for (const b of batches) expect(b.statements.length).toBeLessThanOrEqual(MAX_BATCH_STATEMENTS);
  });

  it('guards each step on the date the previous step set, across batch boundaries', () => {
    const due = dueOccurrences(weekly, '2026-10-19', 10);
    const batches = postingBatches(weekly, due, occurrenceSplits(weekly), opts());
    const guards = batches.flatMap(b => b.statements.filter(st => st.requireChanges));
    expect(guards.map(g => g.params.at(-2))).toEqual(due.map(o => o.date));
    expect(guards.map(g => g.params[0])).toEqual(due.map(o => o.next));
    expect(batches[0].next_due_date).toBe(due[7].next);
    // Each step's stamp guard is the stamp the step before it wrote.
    expect(guards[0].params.at(-1)).toBe(weekly.updated_at);
    for (const g of guards.slice(1)) expect(g.params.at(-1)).toBe('2026-10-19T12:00:00.000Z');
  });

  it('builds the ledger lookup from posted occurrences only', () => {
    const keys = postedOccurrenceKeys([
      { recurring_id: 'rent', occurrence_date: '2026-09-01' },
      { recurring_id: null, occurrence_date: null },
      { recurring_id: 'rent', occurrence_date: '' },
    ]);
    expect([...keys]).toEqual(['rent|2026-09-01']);
  });

  it('advances past a date already in the ledger without inserting it', () => {
    const due = dueOccurrences(rent(), '2026-10-19');
    const [batch] = postingBatches(rent(), due, occurrenceSplits(rent()), opts(['2026-09-01']));
    expect(batch.items.map(i => i.date)).toEqual(['2026-10-01']);
    expect(batch.statements.filter(st => st.requireChanges)).toHaveLength(2);
    expect(batch.statements.filter(st => /INTO app_expense_splitter__expenses /.test(st.sql))).toHaveLength(1);
  });
});

// ── Properties ──────────────────────────────────────────────────────────────

const isoDateArb = fc.date({ min: new Date(Date.UTC(1990, 0, 1)), max: new Date(Date.UTC(2090, 11, 31)), noInvalidDate: true })
  .map(d => d.toISOString().slice(0, 10));
const cadenceArb = fc.constantFrom('weekly', 'monthly', 'yearly');

describe('schedule properties', () => {
  it('every step moves strictly forward onto a real date', () => {
    fc.assert(fc.property(isoDateArb, cadenceArb, fc.integer({ min: 1, max: 31 }), (date, cadence, anchor) => {
      const next = nextOccurrence(date, cadence, anchor);
      expect(parseIsoDate(next)).not.toBeNull();
      expect(next > date).toBe(true);
    }), FC);
  });

  it('a monthly or yearly step lands on the anchor day, clamped to the month', () => {
    fc.assert(fc.property(isoDateArb, fc.constantFrom('monthly', 'yearly'), fc.integer({ min: 1, max: 31 }), (date, cadence, anchor) => {
      const { y, m, d } = parseIsoDate(nextOccurrence(date, cadence, anchor));
      expect(d).toBe(Math.min(anchor, daysInMonth(y, m)));
    }), FC);
  });

  it('a weekly step is exactly seven days', () => {
    fc.assert(fc.property(isoDateArb, date => {
      const a = Date.parse(`${date}T00:00:00Z`);
      const b = Date.parse(`${nextOccurrence(date, 'weekly', 1)}T00:00:00Z`);
      expect(b - a).toBe(7 * 86400000);
    }), FC);
  });

  it('due occurrences are on or before today, after the start, chained, and capped', () => {
    fc.assert(fc.property(isoDateArb, isoDateArb, cadenceArb, fc.integer({ min: 1, max: 31 }), (start, today, cadence, anchor) => {
      const due = dueOccurrences(rent({ next_due_date: start, cadence, anchor_day: anchor }), today);
      expect(due.length).toBeLessThanOrEqual(MAX_POSTS_PER_RUN);
      due.forEach((o, i) => {
        expect(o.date <= today).toBe(true);
        expect(o.date >= start).toBe(true);
        if (i > 0) expect(o.date).toBe(due[i - 1].next);
      });
      if (due.length > 0) expect(due[0].date).toBe(start);
      // Not capped means nothing due was left behind.
      if (due.length < MAX_POSTS_PER_RUN) {
        const after = due.length ? due[due.length - 1].next : start;
        expect(after > today).toBe(true);
      }
    }), FC);
  });

  it('a resumed template restarts at the first occurrence on or after today', () => {
    fc.assert(fc.property(isoDateArb, isoDateArb, cadenceArb, fc.integer({ min: 1, max: 31 }), (start, today, cadence, anchor) => {
      const template = rent({ next_due_date: start, cadence, anchor_day: anchor });
      const resumed = resumeDate(template, today);
      if (start >= today) { expect(resumed).toBe(start); return; }
      // resumeDate's search is bounded at about twenty years of weeks.
      if (Date.parse(today) - Date.parse(start) >= 15 * 365 * 86400000) return;
      expect(resumed >= today).toBe(true);
      // On the template's own schedule, and nothing between today and it was skipped.
      const path = dueOccurrences(template, resumed, 2000);
      expect(path[path.length - 1].date).toBe(resumed);
      expect(path.every(o => o.date < today || o.date === resumed)).toBe(true);
    }), FC);
  });

  it('posting batches stay under the cap and post exactly the dates not already in the ledger', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: MAX_POSTS_PER_RUN }), fc.array(fc.boolean(), { minLength: MAX_POSTS_PER_RUN, maxLength: MAX_POSTS_PER_RUN }), (count, postedMask) => {
      const t = rent({ cadence: 'weekly', next_due_date: '2026-01-05' });
      const due = dueOccurrences(t, '2099-01-01', count);
      const posted = due.filter((_, i) => postedMask[i]).map(o => o.date);
      let k = 0;
      const batches = postingBatches(t, due, occurrenceSplits(t), { isPosted: d => posted.includes(d), newId: () => `x${k++}`, now: 'n' });
      expect(batches.every(b => b.statements.length <= MAX_BATCH_STATEMENTS)).toBe(true);
      expect(batches.flatMap(b => b.items.map(i => i.date))).toEqual(due.map(o => o.date).filter(d => !posted.includes(d)));
      expect(batches.flatMap(b => b.statements.filter(st => st.requireChanges))).toHaveLength(due.length);
      expect(new Set(batches.flatMap(b => b.items.map(i => i.expenseId))).size).toBe(due.length - posted.length);
    }), FC);
  });

  it('an occurrence\'s splits always add up to the expense, never negative', () => {
    const memberArb = fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 1, maxLength: 5 });
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000_000 }), memberArb, fc.integer({ min: 1, max: 20 }), (amount, ids, share) => {
      for (const [type, weights] of [
        ['equal', {}],
        ['shares', Object.fromEntries(ids.map((id, i) => [id, share + i]))],
      ]) {
        const plan = occurrenceSplits(rent({
          amount_cents: amount, split_type: type,
          split_members: JSON.stringify(ids), split_weights: JSON.stringify(weights),
        }));
        expect(plan.splits.reduce((s, x) => s + x.amount_cents, 0)).toBe(amount);
        expect(plan.splits.every(x => x.amount_cents >= 0)).toBe(true);
      }
    }), FC);
  });
});

// ── Exact values at the edges (mutation-testing gaps) ───────────────────────

describe('occurrenceSplits – exact splits and refusals', () => {
  it('splits equally to the cent, the earlier member taking the odd penny', () => {
    expect(occurrenceSplits(rent({ amount_cents: 1001 }))).toEqual({
      splits: [{ member_id: 'ana', amount_cents: 501 }, { member_id: 'sam', amount_cents: 500 }],
      source: 'equal',
    });
  });

  it('posts custom amounts as stored', () => {
    expect(occurrenceSplits(rent({ split_type: 'custom', split_weights: JSON.stringify({ ana: 150000, sam: 50000 }) })))
      .toEqual({
        splits: [{ member_id: 'ana', amount_cents: 150000 }, { member_id: 'sam', amount_cents: 50000 }],
        source: 'custom',
      });
  });

  it('splits by percent', () => {
    expect(occurrenceSplits(rent({ split_type: 'percent', split_weights: JSON.stringify({ ana: 7500, sam: 2500 }) })))
      .toEqual({
        splits: [{ member_id: 'ana', amount_cents: 150000 }, { member_id: 'sam', amount_cents: 50000 }],
        source: 'percent',
      });
  });

  it('accepts a zero share: one member can carry the whole amount', () => {
    expect(occurrenceSplits(rent({ split_type: 'custom', split_weights: JSON.stringify({ ana: 200000, sam: 0 }) })).splits)
      .toEqual([{ member_id: 'ana', amount_cents: 200000 }, { member_id: 'sam', amount_cents: 0 }]);
  });

  it('refuses a bad amount', () => {
    expect(occurrenceSplits(rent({ amount_cents: -200000 }))).toBeNull();
    expect(occurrenceSplits(rent({ amount_cents: 100.5 }))).toBeNull();
    expect(occurrenceSplits(rent({ amount_cents: 'lots' }))).toBeNull();
  });

  it('refuses a custom split that totals the amount through a negative share', () => {
    const t = rent({ split_type: 'custom', split_weights: JSON.stringify({ ana: 250000, sam: -50000 }) });
    expect(occurrenceSplits(t)).toBeNull();
  });

  it('refuses a custom split that totals the amount in fractions of a cent', () => {
    const t = rent({ split_type: 'custom', split_weights: JSON.stringify({ ana: 100000.5, sam: 99999.5 }) });
    expect(occurrenceSplits(t)).toBeNull();
  });

  it('is null for no template', () => {
    expect(occurrenceSplits(null)).toBeNull();
    expect(templateMembers(null)).toEqual([]);
  });
});

describe('templateEnded – boundaries', () => {
  it('is not ended while the next date is on or before the end date', () => {
    expect(templateEnded(rent({ end_date: '2026-12-01', next_due_date: '2026-09-01' }))).toBe(false);
    expect(templateEnded(rent({ end_date: '2026-09-01', next_due_date: '2026-09-01' }))).toBe(false);
    expect(templateEnded(rent({ end_date: '2026-08-31', next_due_date: '2026-09-01' }))).toBe(true);
  });
  it('is not ended with no end date, an empty one, or no template', () => {
    expect(templateEnded(rent({ end_date: '' }))).toBe(false);
    expect(templateEnded(null)).toBe(false);
  });
});

describe('parseIsoDate – strictness', () => {
  it('needs the whole string to be the date', () => {
    expect(parseIsoDate('x2026-01-01')).toBeNull();
    expect(parseIsoDate('2026-01-011')).toBeNull();
    expect(parseIsoDate(['2026-01-01'])).toBeNull();
  });
  it('refuses a two-digit-era year that Date would move into the 1900s', () => {
    expect(parseIsoDate('0050-01-01')).toBeNull();
  });
});

describe('nextOccurrence – anchors and year end', () => {
  it('ignores an anchor day past 31', () => {
    expect(nextOccurrence('2026-01-15', 'monthly', 40)).toBe('2026-02-15');
  });
  it('steps November to December in the same year', () => {
    expect(nextOccurrence('2026-11-10', 'monthly')).toBe('2026-12-10');
  });
});

describe('dueOccurrences / resumeDate – a schedule that cannot step', () => {
  it('posts nothing for an unknown cadence', () => {
    expect(dueOccurrences(rent({ cadence: 'hourly' }), '2026-10-19')).toEqual([]);
  });
  it('leaves an unknown cadence where it is on resume', () => {
    expect(resumeDate(rent({ cadence: 'hourly', next_due_date: '2026-06-01' }), '2026-10-19')).toBe('2026-06-01');
  });
  it('resumes nothing for no template, and leaves the date alone when today is unreadable', () => {
    expect(resumeDate(null, '2026-10-19')).toBeNull();
    expect(resumeDate(rent({ next_due_date: '2026-06-01' }), 'garbage')).toBe('2026-06-01');
  });
  it('stops after 1100 steps', () => {
    // 1100 weeks after 2000-01-01, still short of today.
    expect(resumeDate(rent({ cadence: 'weekly', next_due_date: '2000-01-01' }), '2030-01-01')).toBe('2021-01-30');
  });
});

describe('reminderColumns / parseJsonField – missing input', () => {
  it('switches reminders off for no template', () => {
    expect(reminderColumns(null)).toEqual({ remind: 0, remind_to: 'payer' });
  });
  it('passes an already-parsed object through', () => {
    const obj = { ana: 1 };
    expect(parseJsonField(obj, null)).toBe(obj);
  });
  it('lists the reminder choices in form order', () => {
    expect(REMIND_SCOPES.map(s => s.id)).toEqual(['payer', 'household', 'off']);
  });
});

describe('templateProblem / scheduleLabel – unreadable templates', () => {
  it('names an unreadable schedule for no template', () => {
    expect(templateProblem(null, ['ana'])).toMatch(/unreadable schedule/);
    expect(scheduleLabel(null)).toBe('Unreadable schedule');
    expect(scheduleLabel(rent({ cadence: 'hourly' }))).toBe('Unreadable schedule');
  });
  it('labels a paused weekly template', () => {
    expect(scheduleLabel(rent({ cadence: 'weekly', active: 0 }))).toBe('Every week · paused');
  });
});

describe('occurrenceStatements – reminders and empty splits', () => {
  const opts = { expenseId: 'exp-1', splitIds: [], now: '2026-10-19T12:00:00.000Z' };

  it('writes the reminder columns of the template as it will stand after the step', () => {
    const [update] = occurrenceStatements(rent({ remind_scope: 'household' }),
      { date: '2026-09-01', next: '2026-10-01' }, null, opts);
    expect(update.params.slice(0, 3)).toEqual(['2026-10-01', 1, 'household']);
  });

  it('adds no splits statement for a plan with no splits', () => {
    const st = occurrenceStatements(rent(), { date: '2026-09-01', next: '2026-10-01' },
      { splits: [], source: 'equal' }, opts);
    expect(st).toHaveLength(2);
  });
});

describe('anchorForSave – which anchor survives an edit', () => {
  it('re-anchors on the date when switching to weekly', () => {
    const editing = rent({ anchor_day: 31, next_due_date: '2026-04-30', cadence: 'monthly' });
    expect(anchorForSave(editing, '2026-04-30', 'weekly')).toBe(30);
    expect(anchorForSave(editing, '2026-04-30', 'yearly')).toBe(31);
  });
  it('keeps only a stored anchor between 1 and 31', () => {
    const at = (anchor_day) => anchorForSave(rent({ anchor_day, next_due_date: '2026-09-15' }), '2026-09-15', 'monthly');
    expect(at(1)).toBe(1);
    expect(at(31)).toBe(31);
    expect(at(0)).toBe(15);
    expect(at(40)).toBe(15);
  });
});

describe('scheduleFormError – kept schedules', () => {
  it('still refuses a live template kept on a date more than a year back', () => {
    const stored = rent({ next_due_date: '2024-01-01' });
    expect(scheduleFormError('2024-01-01', '', '2026-10-27', stored)).toMatch(/more than a year ago/);
  });
  it('lets a paused template keep its old date while its end date changes', () => {
    const stored = rent({ active: 0, next_due_date: '2025-01-01' });
    expect(scheduleFormError('2025-01-01', '2027-01-01', '2026-10-27', stored)).toBeNull();
  });
});

describe('isStaleConflict / postedOccurrenceKeys – missing input', () => {
  it('is not a conflict with no error', () => {
    expect(isStaleConflict(undefined)).toBe(false);
  });
  it('skips a missing row', () => {
    expect([...postedOccurrenceKeys([null, { recurring_id: 'rent', occurrence_date: '2026-09-01' }])])
      .toEqual(['rent|2026-09-01']);
  });
});

describe('postingBatches – exact statements', () => {
  it('builds no batch for no occurrences', () => {
    expect(postingBatches(rent(), [], occurrenceSplits(rent()), { isPosted: () => false, newId: () => 'x', now: 'n' })).toEqual([]);
  });

  it('gives each occurrence its expense id and split ids, in order', () => {
    let n = 0;
    const plan = occurrenceSplits(rent());
    const [batch] = postingBatches(rent(), [{ date: '2026-09-01', next: '2026-10-01' }], plan,
      { isPosted: () => false, newId: () => `id-${++n}`, now: 'NOW' });
    expect(batch.statements).toHaveLength(3);
    expect(batch.statements[0].params[3]).toBe('NOW');
    expect(batch.statements[1].params[0]).toBe('id-1');
    expect(batch.statements[1].params[7]).toBe('NOW');
    expect(batch.statements[2].params).toEqual(['id-2', 'id-1', 'ana', 100000, 'id-3', 'id-1', 'sam', 100000]);
    expect(batch.items).toEqual([{ date: '2026-09-01', expenseId: 'id-1' }]);
  });
});

describe('reminderSyncStatement – one column out of line', () => {
  it('writes when only remind differs', () => {
    expect(reminderSyncStatement(rent({ remind: 0, remind_to: 'payer', remind_scope: 'payer' }), false).params)
      .toEqual([1, 'payer', 'rent', '2026-08-01T00:00:00.000Z']);
  });
  it('writes when only remind_to differs', () => {
    expect(reminderSyncStatement(rent({ remind: 1, remind_to: 'payer', remind_scope: 'household' }), false).params)
      .toEqual([1, 'household', 'rent', '2026-08-01T00:00:00.000Z']);
  });
});
