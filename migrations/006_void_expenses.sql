-- v1.6.0 — an expense is removed, never deleted; a payment is reversed.
--
-- A shared expense is part of the record two people keep together. "Remove"
-- sets the three void columns in one UPDATE: the row, its splits and its
-- receipt stay, balances and summaries leave it out, and the export lists it
-- with who removed it, when and why. Removing is final: a mistaken removal is
-- answered by adding the expense again. The manifest's frozen_when on voided_at
-- has the hub refuse every later UPDATE or DELETE of a removed expense, so the
-- first removal's who, when and why stand and it cannot be brought back. The
-- manifest locks every other column of expenses, expense_splits and
-- settlements against UPDATE, so what was recorded cannot be rewritten in
-- place either; a correction is Remove, then add it again.
--
-- voided_at and voided_by_id carry the codec's plaintext suffixes because SQL
-- filters on voided_at. void_reason is encrypted and only displayed. None of
-- them has a DEFAULT: NULL means "not removed", and the page writes NULL, never
-- an empty string, when no reason is given.
--
-- voided_at must look like a timestamp, and voided_by_id is set exactly when
-- voided_at is. Without the first, a member could write '' or junk: SQL would
-- treat the expense as removed while the export's Removed column showed
-- nothing. Without the second, a live expense could carry a "removed by".
-- Both columns are plaintext, so SQLite can check them; ADD COLUMN may carry a
-- CHECK because every existing row holds NULL in both.
--
-- voided_by_id is written by the page as the signed-in member. The hub does not
-- force it; the change history records who actually wrote each UPDATE, and the
-- export labels these columns as the app recorded them.
ALTER TABLE app_expense_splitter__expenses ADD COLUMN voided_at TEXT
  CHECK (voided_at IS NULL OR voided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]*');
ALTER TABLE app_expense_splitter__expenses ADD COLUMN voided_by_id TEXT
  CHECK ((voided_at IS NULL) = (voided_by_id IS NULL));
ALTER TABLE app_expense_splitter__expenses ADD COLUMN void_reason TEXT;

-- A payment recorded by mistake is answered by a payment the other way, which
-- names the one it reverses. Both stay in the record; the pair nets to zero.
ALTER TABLE app_expense_splitter__settlements ADD COLUMN reverses_id TEXT;

-- A payment is reversed once. Two parents pressing Reverse at the same moment
-- would otherwise both insert, and the second reversal would move the money
-- back a second time. The hub cannot check that a row naming a payment is its
-- true reverse, so the index covers the parties and amount too: a row that
-- names a payment but does not match it is an ordinary payment, and it cannot
-- take the one slot the matching reversal needs. NULLs are distinct, so
-- ordinary payments are unaffected. amount_cents is in db_plaintext_columns:
-- the codec never encrypts a number, and a unique index needs the column to be
-- declared plaintext so it can compare the values.
CREATE UNIQUE INDEX IF NOT EXISTS app_expense_splitter__settlements_reverses_idx
  ON app_expense_splitter__settlements (reverses_id, from_id, to_id, amount_cents);

-- A member appears once in an expense's split. The page never writes the same
-- member twice, but split rows are insert-only and any adult can add one, so a
-- second row for the other parent on an old expense would raise their share.
-- The page and the export flag an expense whose shares do not add up.
CREATE UNIQUE INDEX IF NOT EXISTS app_expense_splitter__expense_splits_member_idx
  ON app_expense_splitter__expense_splits (expense_id, member_id);
