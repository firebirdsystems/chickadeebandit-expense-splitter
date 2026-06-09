-- Expenses: one row per shared expense
CREATE TABLE IF NOT EXISTS expenses (
  household_id  UUID    NOT NULL DEFAULT current_setting('app.household_id', true)::uuid,
  id            TEXT    NOT NULL,
  paid_by       TEXT    NOT NULL,
  amount_cents  INTEGER NOT NULL,
  description   TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'other',
  date          TEXT    NOT NULL,
  split_type    TEXT    NOT NULL DEFAULT 'equal',
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (household_id, id)
);

-- Expense splits: one row per member per expense (including the payer's own share)
CREATE TABLE IF NOT EXISTS expense_splits (
  household_id  UUID    NOT NULL DEFAULT current_setting('app.household_id', true)::uuid,
  id            TEXT    NOT NULL,
  expense_id    TEXT    NOT NULL,
  member_id     TEXT    NOT NULL,
  amount_cents  INTEGER NOT NULL,
  PRIMARY KEY (household_id, id)
);

-- Settlements: records of payments between members to clear debts
CREATE TABLE IF NOT EXISTS settlements (
  household_id  UUID    NOT NULL DEFAULT current_setting('app.household_id', true)::uuid,
  id            TEXT    NOT NULL,
  from_id       TEXT    NOT NULL,
  to_id         TEXT    NOT NULL,
  amount_cents  INTEGER NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  settled_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (household_id, id)
);
