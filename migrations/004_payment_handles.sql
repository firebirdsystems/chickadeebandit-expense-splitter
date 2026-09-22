-- v1.4.0 — where to send the money.
--
-- Recording "Sam owes Ana $140" and then leaving both of them to go find each
-- other in a payment app is the step this app used to stop one move short of.
-- A handle stored once turns "settle up" into a link.
--
-- One row per member. `service` is an app-side enum ('venmo' | 'paypal' |
-- 'cashapp' | 'zelle' | 'other') and `handle` is the username on it. Neither is
-- ever compared in SQL, so both are left to the codec and stored encrypted —
-- a payment handle is not household prose, but it is not public either, and
-- nothing here needs it in the clear.
--
-- READS ARE OPEN ON PURPOSE. The whole point is that the person who OWES you
-- can see where to send it, and in a shared space `adults_bypass` resolves to
-- the steward alone (see policy-roles.ts), so an owner_only table would have
-- hidden a co-parent's handle from the co-parent who has to pay it. The
-- manifest instead pairs `member_writable` with `column_write_acls`, which pins
-- every writable column to its owner: an INSERT must carry the caller's own
-- member_id, and an UPDATE is rewritten with an owner-equality WHERE guard.
--
-- The one gap that leaves is DELETE, which column ACLs do not cover — any
-- member can drop another member's row through a hand-written /api/db call.
-- That is a nuisance (the owner re-enters it), not a redirection: nobody can
-- write a handle into somebody else's name, which is the failure that would
-- actually move money to the wrong person.
CREATE TABLE IF NOT EXISTS app_expense_splitter__payment_handles (
  id         TEXT NOT NULL PRIMARY KEY,
  member_id  TEXT NOT NULL,
  service    TEXT NOT NULL,
  handle     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- member_id carries the `_id` suffix, so the codec leaves it in plaintext and a
-- UNIQUE index over it is a real constraint rather than one over ciphertext
-- that every row would satisfy by accident.
CREATE UNIQUE INDEX IF NOT EXISTS app_expense_splitter__payment_handles_member_idx
  ON app_expense_splitter__payment_handles (member_id);
