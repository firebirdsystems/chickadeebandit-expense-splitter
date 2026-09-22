SELECT
  e.category AS category,
  COUNT(*) AS expense_count,
  SUM(e.amount_cents) AS total_cents,
  MIN(e.date) AS first_date,
  MAX(e.date) AS last_date
FROM app_expense_splitter__expenses e
GROUP BY e.category
ORDER BY total_cents DESC
LIMIT 50
