SELECT
  e.category AS category,
  COUNT(*) AS expense_count,
  SUM(CASE WHEN typeof(e.amount_cents) = 'integer' THEN e.amount_cents ELSE 0 END) AS total_cents,
  MIN(e.date) AS first_date,
  MAX(e.date) AS last_date
FROM app_expense_splitter__expenses e
WHERE e.voided_at IS NULL
GROUP BY e.category
ORDER BY total_cents DESC
LIMIT 50
