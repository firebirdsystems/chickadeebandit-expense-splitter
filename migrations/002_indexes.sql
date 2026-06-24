CREATE INDEX IF NOT EXISTS idx_splits_expense ON app_expense_splitter__expense_splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON app_expense_splitter__expenses(date DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_at ON app_expense_splitter__settlements(settled_at DESC);
