-- v1.5.0 — repeating expenses: rent, daycare, a phone plan.
--
-- A repeating expense is a TEMPLATE. Each time it comes due, the page posts it
-- as an ordinary row in `expenses` plus its `expense_splits`, so balances,
-- settlements, reimbursements, reports and receipts treat an occurrence
-- exactly like an expense typed in by hand. Nothing on the hub runs the
-- schedule: an adult opening the app posts whatever has come due, dated the
-- day it was due.
--
-- Column names carry the codec's plaintext suffixes (_id, _date, _by, _at)
-- wherever SQL compares them; `remind_scope` and `remind_to` are listed in the
-- manifest's db_plaintext_columns for the same reason, and `category` is on the
-- hub's built-in plaintext list (BUILTIN_APP_DB_PLAINTEXT_COLS), which is why
-- its DEFAULT 'other' is safe. Everything else is
-- encrypted at rest and only displayed or parsed by the page, and has no
-- string DEFAULT: SQLite would apply it outside the codec, as plaintext. The
-- page writes every column on every INSERT.
CREATE TABLE IF NOT EXISTS app_expense_splitter__recurring_expenses (
  id             TEXT    NOT NULL PRIMARY KEY,
  description    TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL,
  category       TEXT    NOT NULL DEFAULT 'other',
  paid_by        TEXT    NOT NULL,
  -- The method picked on the form ('equal' | 'shares' | 'percent' | 'custom'),
  -- not the rule that ends up applied: an occurrence on Equal follows the
  -- category's saved split as it stands on the day it posts.
  split_type     TEXT    NOT NULL DEFAULT 'equal',
  split_members  TEXT    NOT NULL,                -- JSON array of member ids
  split_weights  TEXT    NOT NULL,                -- JSON: shares, basis points, or cents (custom)
  cadence        TEXT    NOT NULL,                -- 'weekly' | 'monthly' | 'yearly'
  -- The day of the month it is really due. next_due_date is clamped to short
  -- months; the anchor is what brings a 31st-of-the-month rent back to the 31st.
  anchor_day     INTEGER NOT NULL,
  -- The next occurrence not yet posted. Posting moves it on, guarded by its
  -- current value, which is what keeps two adults from posting the same month.
  next_due_date  TEXT    NOT NULL,
  end_date       TEXT,                             -- last date that may post; NULL = no end
  active         INTEGER NOT NULL DEFAULT 1,       -- 0 = paused
  -- Reminders, read by the hub's date_reminders protocol. remind_scope is the
  -- household's choice ('payer' | 'household' | 'off'). remind (on/off) and
  -- remind_to (audience: 'household' also means "on the household calendar")
  -- are DERIVED from it by the page on every write, switched off and narrowed
  -- to the payer while the template is paused or ended (reminderColumns in
  -- logic.js), so neither the email nor the calendar announces an occurrence
  -- that will not post.
  remind_scope   TEXT    NOT NULL DEFAULT 'payer',
  remind         INTEGER NOT NULL DEFAULT 1,
  remind_to      TEXT    NOT NULL DEFAULT 'payer',
  last_reminded_at TEXT,                           -- stamped by the hub's reminder cron
  created_by     TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- No index on the schedule columns: the page reads every template and the
-- hub's reminder lane reads the whole table, so nothing seeks by them.

-- Which template an expense was posted from, and for which due date. NULL on
-- every expense entered by hand. Deleting a template leaves what it already
-- posted in place: those are real expenses in the ledger.
ALTER TABLE app_expense_splitter__expenses ADD COLUMN recurring_id TEXT;
ALTER TABLE app_expense_splitter__expenses ADD COLUMN occurrence_date TEXT;

-- The backstop under the guarded UPDATE: one expense per template per due
-- date. NULLs are distinct in SQLite, so hand-entered expenses never collide.
CREATE UNIQUE INDEX IF NOT EXISTS app_expense_splitter__expenses_occurrence_idx
  ON app_expense_splitter__expenses (recurring_id, occurrence_date);
