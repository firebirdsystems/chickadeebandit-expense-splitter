-- v1.2.0 — receipts, per-category split defaults, and countersigned reimbursements.
--
-- Context: this app now runs in shared spaces (manifest `contexts`), where the
-- two parties are co-parents in separate homes rather than housemates. That
-- changes what a settlement means. The existing one-tap `settlements` flow is
-- deliberately left alone — inside one household "I paid you back" is a fine
-- unilateral note. Across two households it is a claim about someone else's
-- money, so this migration adds a SECOND, countersigned path alongside it.

-- Receipt image/PDF for an expense (R2 file id from files.upload()).
-- Nullable: existing expenses have none, and receipts stay optional.
ALTER TABLE app_expense_splitter__expenses ADD COLUMN receipt_file_id TEXT;

-- Saved default split for a category, e.g. medical 50/50 but activities 70/30.
-- One row per (category, member). Absent category => fall back to an even split
-- across the selected members, which is the pre-1.2.0 behavior.
-- percent is in BASIS POINTS (10000 = 100%) so thirds don't lose precision.
CREATE TABLE IF NOT EXISTS app_expense_splitter__category_splits (
  id           TEXT    NOT NULL PRIMARY KEY,
  category     TEXT    NOT NULL,
  member_id    TEXT    NOT NULL,
  percent_bp   INTEGER NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- A request to be paid back. party_scoped: only the two parties see or touch it.
-- Terms live here; consent lives in reimbursement_agreements so a party cannot
-- forge the other's approval through /api/db.
--   status: 'pending' | 'cancelled' | 'settled'   ('locked' is derived from the
--           agreements table, exactly as co-parenting's swap_requests does)
CREATE TABLE IF NOT EXISTS app_expense_splitter__reimbursements (
  id           TEXT    NOT NULL PRIMARY KEY,
  requester_id TEXT    NOT NULL,   -- who is owed
  payer_id     TEXT    NOT NULL,   -- who owes
  amount_cents INTEGER NOT NULL,
  note         TEXT    NOT NULL DEFAULT '',
  expense_id   TEXT,               -- optional link to the expense that caused it
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- Countersign state. endpoint_only: /api/agree is the only writer. On lock the
-- hub snapshots amount_cents + note onto this row, so what both parties agreed
-- to survives any later edit of the request itself.
CREATE TABLE IF NOT EXISTS app_expense_splitter__reimbursement_agreements (
  id               TEXT    NOT NULL PRIMARY KEY,   -- same id as reimbursements
  requester_id     TEXT    NOT NULL,
  payer_id         TEXT    NOT NULL,
  requester_agreed INTEGER NOT NULL DEFAULT 0,
  payer_agreed     INTEGER NOT NULL DEFAULT 0,
  amount_cents     INTEGER,                        -- snapshot, set at lock
  note             TEXT,                           -- snapshot, set at lock
  status           TEXT    NOT NULL DEFAULT 'pending',
  locked_at        TEXT,
  updated_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS app_expense_splitter__category_splits_cat_idx
  ON app_expense_splitter__category_splits (category);
CREATE INDEX IF NOT EXISTS app_expense_splitter__reimbursements_parties_idx
  ON app_expense_splitter__reimbursements (requester_id, payer_id);
