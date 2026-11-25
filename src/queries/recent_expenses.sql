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
WHERE e.voided_at IS NULL
ORDER BY e.date DESC, e.created_at DESC
LIMIT 100
