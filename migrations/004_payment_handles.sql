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
-- hidden a co-parent's handle from the co-parent who has to pay it.
--
-- The manifest instead pairs `owner_or_visibility` with `write_owner_only`, which is
-- the only shape that gets both halves. Reads: own rows always, plus every row
-- whose `visibility` is in `everyone_values` — and the app writes 'everyone' on
-- every row, so in practice the whole table, which is the point. Writes: INSERT
-- has member_id FORCED to the caller, and UPDATE and DELETE are both rewritten
-- with an owner-equality guard, with no supervisor bypass.
--
-- `member_writable` + `column_write_acls` was the first attempt and covered one
-- statement short: column ACLs are a no-op on DELETE by construction (see
-- enforceColumnWriteAcls, which returns early for anything but insert/update),
-- so any member could drop another member's row through a hand-written /api/db
-- call. Nobody could redirect a payment — the ACLs did stop a handle being
-- written in someone else's name — but they could keep deleting yours, and the
-- settle-up screen has no link while the row is missing. The UI promises "Only
-- you can change it"; this is the policy that makes that true.
CREATE TABLE IF NOT EXISTS app_expense_splitter__payment_handles (
  id         TEXT NOT NULL PRIMARY KEY,
  member_id  TEXT NOT NULL,
  service    TEXT NOT NULL,
  handle     TEXT NOT NULL,
  -- Carries the read rule for owner_or_visibility. Constant 'everyone' today —
  -- the column exists because the policy kind needs one, not because a handle
  -- has ever been meant to be private. `visibility` is a built-in plaintext
  -- column name, so the IN (...) the policy appends is a real comparison rather
  -- than one against AES ciphertext that would match nothing.
  visibility TEXT NOT NULL DEFAULT 'everyone',
  updated_at TEXT NOT NULL
);

-- member_id carries the `_id` suffix, so the codec leaves it in plaintext and a
-- UNIQUE index over it is a real constraint rather than one over ciphertext
-- that every row would satisfy by accident.
CREATE UNIQUE INDEX IF NOT EXISTS app_expense_splitter__payment_handles_member_idx
  ON app_expense_splitter__payment_handles (member_id);
