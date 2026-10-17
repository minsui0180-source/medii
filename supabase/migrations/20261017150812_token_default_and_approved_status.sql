/*
# Addendum: token default + APPROVED status

1. queue_entries.token now defaults to 'OPD-' + padded queue_token_seq (spec 1c).
2. queue_entries.status gains APPROVED so doctors can approve entries (spec 2, /staff/approve).
*/

ALTER TABLE queue_entries ALTER COLUMN token SET DEFAULT 'OPD-' || lpad(nextval('queue_token_seq')::text, 4, '0');

ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS queue_entries_status_check;
ALTER TABLE queue_entries ADD CONSTRAINT queue_entries_status_check
  CHECK (status IN ('WAITING','SENT_TO_DOCTOR','APPROVED','IN_CONSULT','DONE'));
