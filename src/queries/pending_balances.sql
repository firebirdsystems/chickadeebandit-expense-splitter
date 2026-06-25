-- Net balance per member, in cents. Positive = owed money (creditor);
-- negative = owes money (debtor). Mirrors computeBalances() in src/logic.js:
-- the payer of each expense is owed every split share, each member owes their
-- own share, and settlements move money from the payer to the recipient.
WITH deltas AS (
  -- Payer is owed each split share on the expenses they paid for
  SELECT e.paid_by AS member_id, s.amount_cents AS delta
  FROM app_expense_splitter__expense_splits s
  JOIN app_expense_splitter__expenses e ON e.id = s.expense_id
  UNION ALL
  -- Each member owes their own split share
  SELECT s.member_id AS member_id, -s.amount_cents AS delta
  FROM app_expense_splitter__expense_splits s
  UNION ALL
  -- Settling member pays down their debt
  SELECT st.from_id AS member_id, st.amount_cents AS delta
  FROM app_expense_splitter__settlements st
  UNION ALL
  -- Recipient has been paid back
  SELECT st.to_id AS member_id, -st.amount_cents AS delta
  FROM app_expense_splitter__settlements st
)
SELECT member_id, SUM(delta) AS net_cents
FROM deltas
GROUP BY member_id
HAVING SUM(delta) <> 0
ORDER BY net_cents DESC
LIMIT 50
