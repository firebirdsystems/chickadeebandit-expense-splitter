WITH deltas AS (
  SELECT e.paid_by AS member_id, s.amount_cents AS delta
  FROM app_expense_splitter__expense_splits s
  JOIN app_expense_splitter__expenses e ON e.id = s.expense_id
  WHERE e.voided_at IS NULL AND typeof(e.amount_cents) = 'integer' AND typeof(s.amount_cents) = 'integer'
  UNION ALL
  SELECT s.member_id AS member_id, -s.amount_cents AS delta
  FROM app_expense_splitter__expense_splits s
  JOIN app_expense_splitter__expenses e ON e.id = s.expense_id
  WHERE e.voided_at IS NULL AND typeof(e.amount_cents) = 'integer' AND typeof(s.amount_cents) = 'integer'
  UNION ALL
  SELECT st.from_id AS member_id, st.amount_cents AS delta
  FROM app_expense_splitter__settlements st
  WHERE typeof(st.amount_cents) = 'integer'
  UNION ALL
  SELECT st.to_id AS member_id, -st.amount_cents AS delta
  FROM app_expense_splitter__settlements st
  WHERE typeof(st.amount_cents) = 'integer'
)
SELECT member_id, SUM(delta) AS net_cents
FROM deltas
GROUP BY member_id
HAVING SUM(delta) <> 0
ORDER BY net_cents DESC
LIMIT 50
