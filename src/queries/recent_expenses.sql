-- Most recent shared expenses, newest first.
SELECT
  e.id,
  e.description,
  e.amount_cents,
  e.category,
  e.paid_by,
  e.date,
  e.split_type,
  e.created_at
FROM app_expense_splitter__expenses e
ORDER BY e.date DESC, e.created_at DESC
LIMIT 100
