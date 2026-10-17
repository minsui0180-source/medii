/*
# Swasthya Setu — security lockdown + ASV locator

1. Security changes
   - Drops ALL "public ..." RLS policies. From now on anon/authenticated can read/write NOTHING.
     Every data access goes through the edge function using the service role.
   - staff_users: adds password_hash (SHA-256), removes plaintext password, adds hospital_id link.
   - audit_log + custody_events become append-only via trigger (UPDATE/DELETE raise an exception).
2. Schema changes
   - queue_entries: manual_rank, token_seq, approved_by/at/summary, triage_floor, unique token default from sequence.
   - emergency_requests: current_target_hospital_id, target_deadline_at, kind AMBULANCE/ABHA_FAMILY (WALKIN migrated), status + CANCELLED.
   - New tables: asv_stock, transfer_requests, transfer_legs, custody_events.
   - hospitals: extra raw jsonb + area/city/ownership columns; replaced 6-row seed with 20-row seed.
3. Seed data (DEMO)
   - 20 Delhi-NCR demo hospitals (fictional names per USE_REAL_HOSPITAL_NAMES=false).
   - asv_stock batches per hospital (0-quantity hospitals get no row).
   - 2 ABHA demo patients, 3 staff logins with SHA-256 password hashes (password "demo123").
4. Notes
   - No anon/authenticated policies are created anywhere on purpose (lockdown).
*/

-- ============ 1. RLS LOCKDOWN ============
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND policyname LIKE 'public %'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- ============ 2. STAFF + HOSPITAL columns ============
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS hospital_id uuid REFERENCES hospitals(id);

ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS raw jsonb;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS area text NOT NULL DEFAULT '';
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS city text NOT NULL DEFAULT '';
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS ownership text NOT NULL DEFAULT 'Government';

-- ============ 3. QUEUE ENTRIES columns ============
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS manual_rank int;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS token_seq bigint;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS approved_summary jsonb;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS triage_floor text NOT NULL DEFAULT 'ROUTINE'
  CHECK (triage_floor IN ('ROUTINE','URGENT'));
ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS queue_entries_triage_level_check;
ALTER TABLE queue_entries ADD CONSTRAINT queue_entries_triage_level_check
  CHECK (triage_level IN ('ROUTINE','URGENT','EMERGENCY'));

CREATE SEQUENCE IF NOT EXISTS queue_token_seq START 1;
UPDATE queue_entries SET token_seq = COALESCE(token_seq, nextval('queue_token_seq'));
ALTER TABLE queue_entries ALTER COLUMN token_seq SET DEFAULT nextval('queue_token_seq');
UPDATE queue_entries SET token = 'OPD-' || lpad(token_seq::text, 4, '0');
CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_token_key ON queue_entries(token);

-- ============ 4. EMERGENCY REQUESTS columns ============
ALTER TABLE emergency_requests ADD COLUMN IF NOT EXISTS current_target_hospital_id uuid REFERENCES hospitals(id);
ALTER TABLE emergency_requests ADD COLUMN IF NOT EXISTS target_deadline_at timestamptz;
ALTER TABLE emergency_requests DROP CONSTRAINT IF EXISTS emergency_requests_kind_check;
ALTER TABLE emergency_requests ADD CONSTRAINT emergency_requests_kind_check
  CHECK (kind IN ('AMBULANCE','ABHA_FAMILY'));
UPDATE emergency_requests SET kind = 'AMBULANCE' WHERE kind = 'WALKIN';
ALTER TABLE emergency_requests DROP CONSTRAINT IF EXISTS emergency_requests_status_check;
ALTER TABLE emergency_requests ADD CONSTRAINT emergency_requests_status_check
  CHECK (status IN ('BROADCASTING','ACCEPTED','DECLINED_ALL','CANCELLED'));

-- ============ 5. NEW ASV TABLES ============
CREATE TABLE IF NOT EXISTS asv_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id),
  batch_code text NOT NULL,
  quantity int NOT NULL CHECK (quantity >= 0),
  expiry_date date NOT NULL,
  product text NOT NULL DEFAULT 'Polyvalent ASV',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  UNIQUE (hospital_id, batch_code)
);

CREATE TABLE IF NOT EXISTS transfer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_ref text,
  requesting_hospital_id uuid REFERENCES hospitals(id),
  vials_needed int NOT NULL,
  decided_by_doctor text,
  status text CHECK (status IN ('PLANNING','REQUESTED','ACCEPTED','PARTIAL','CLOSED','CANCELLED')) DEFAULT 'PLANNING',
  move_mode text CHECK (move_mode IN ('MOVE_PATIENT','MOVE_MEDICINE')),
  plan jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfer_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid REFERENCES transfer_requests(id),
  source_hospital_id uuid REFERENCES hospitals(id),
  batch_id uuid REFERENCES asv_stock(id),
  vials int NOT NULL,
  status text CHECK (status IN ('REQUESTED','ACCEPTED','DECLINED','TIMED_OUT','DISPATCHED','RECEIVED','CANCELLED')),
  deadline_at timestamptz,
  decline_reason text,
  sequence_no int NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leg_id uuid REFERENCES transfer_legs(id),
  event text CHECK (event IN ('STOCK_HELD','REQUESTED','ACCEPTED','DISPATCHED','HANDOVER','RECEIVED','DECLINED','TIMED_OUT')),
  location_name text NOT NULL,
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  details jsonb
);

-- ============ 6. APPEND-ONLY triggers ============
CREATE OR REPLACE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS custody_events_append_only ON custody_events;
CREATE TRIGGER custody_events_append_only
  BEFORE UPDATE OR DELETE ON custody_events
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

-- ============ 7. RLS enable everywhere (no policies = deny all) ============
ALTER TABLE asv_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_events ENABLE ROW LEVEL SECURITY;

-- ============ 8. SEED: replace hospitals with 20-row demo set ============
DELETE FROM custody_events;
DELETE FROM transfer_legs;
DELETE FROM transfer_requests;
DELETE FROM asv_stock;
DELETE FROM emergency_requests;
DELETE FROM queue_entries;
DELETE FROM hospitals;

INSERT INTO hospitals (id, name, address, area, city, ownership, lat, lng, specialties, icu_beds_total, icu_beds_available, ventilators_available, specialists_on_duty, blood_stock, emergency_capable, queue_length, raw) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Demo General Hospital 01', 'Connaught Place, New Delhi', 'Connaught Place', 'New Delhi', 'Government', 28.6315, 77.2167, ARRAY['General Medicine','Toxicology'], 40, 12, 12, ARRAY['Dr. A (Tox)','Dr. B (Gen)'], '{"A+":6,"B+":4,"O+":8}', true, 5, '{"hospital_id":"h01","ownership":"Government","beds":{"total":600,"icu":40},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":12},"resources":{"asv":{"quantity":25,"updated_at":"2026-10-17T09:40:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000002', 'Demo Medical Institute 02', 'Ansari Nagar, New Delhi', 'Ansari Nagar', 'New Delhi', 'Government', 28.5672, 77.2100, ARRAY['General Medicine','Toxicology','Neurology'], 100, 45, 30, ARRAY['Dr. C (Tox)','Dr. D (Neuro)'], '{"A+":10,"B+":7,"O+":12}', true, 8, '{"hospital_id":"h02","ownership":"Government","beds":{"total":2000,"icu":100},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":30},"resources":{"asv":{"quantity":40,"updated_at":"2026-10-17T10:20:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000003', 'Demo District Hospital 03', 'Rohini, New Delhi', 'Rohini', 'New Delhi', 'Government', 28.7495, 77.0565, ARRAY['General Medicine','Paediatrics'], 20, 8, 6, ARRAY['Dr. E (Gen)'], '{"A+":5,"B+":3,"O+":6}', true, 7, '{"hospital_id":"h03","ownership":"Government","beds":{"total":350,"icu":20},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":6},"resources":{"asv":{"quantity":10,"updated_at":"2026-10-17T08:05:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000004', 'Demo Trauma Centre 04', 'Civil Lines, New Delhi', 'Civil Lines', 'New Delhi', 'Government', 28.6667, 77.2167, ARRAY['Trauma','Toxicology'], 15, 6, 4, ARRAY['Dr. F (Trauma)'], '{"A+":2,"B+":2,"O+":4}', true, 3, '{"hospital_id":"h04","ownership":"Government","beds":{"total":150,"icu":15},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":4},"resources":{"asv":{"quantity":5,"updated_at":"2026-10-17T07:45:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000005', 'Demo Multispeciality 05', 'Saket, New Delhi', 'Saket', 'New Delhi', 'Private', 28.5245, 77.2066, ARRAY['General Medicine','Orthopaedics'], 30, 10, 8, ARRAY['Dr. G (Gen)'], '{"A+":4,"B+":5,"O+":7}', true, 12, '{"hospital_id":"h05","ownership":"Private","beds":{"total":250,"icu":30},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":8},"resources":{"asv":{"quantity":15,"updated_at":"2026-10-17T10:55:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000006', 'Demo Care Hospital 06', 'Dwarka, New Delhi', 'Dwarka', 'New Delhi', 'Private', 28.5921, 77.0460, ARRAY['General Medicine'], 18, 5, 5, ARRAY['Dr. H (Gen)'], '{"A+":3,"B+":2,"O+":5}', true, 9, '{"hospital_id":"h06","ownership":"Private","beds":{"total":180,"icu":18},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":5},"resources":{"asv":{"quantity":0,"updated_at":"2026-10-17T06:30:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000007', 'Demo Govt Hospital 07', 'Jhandewalan, New Delhi', 'Jhandewalan', 'New Delhi', 'Government', 28.6521, 77.1789, ARRAY['General Medicine'], 12, 4, 3, ARRAY['Dr. I (Gen)'], '{"A+":2,"B+":1,"O+":3}', true, 6, '{"hospital_id":"h07","ownership":"Government","beds":{"total":220,"icu":12},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":3},"resources":{"asv":{"quantity":8,"updated_at":"2026-10-16T20:00:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000008', 'Demo Institute 08', 'Shahdara, New Delhi', 'Shahdara', 'New Delhi', 'Government', 28.6733, 77.2969, ARRAY['General Medicine','Toxicology'], 25, 9, 9, ARRAY['Dr. J (Tox)'], '{"A+":3,"B+":4,"O+":6}', true, 4, '{"hospital_id":"h08","ownership":"Government","beds":{"total":400,"icu":25},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":9},"resources":{"asv":{"quantity":18,"updated_at":"2026-10-17T09:10:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000009', 'Demo Nursing Home 09', 'Lajpat Nagar, New Delhi', 'Lajpat Nagar', 'New Delhi', 'Private', 28.5677, 77.2432, ARRAY['General Medicine'], 8, 2, 2, ARRAY['Dr. K (Gen)'], '{"A+":1,"B+":1,"O+":2}', false, 2, '{"hospital_id":"h09","ownership":"Private","beds":{"total":90,"icu":8},"capabilities":{"emergency":false,"toxicology":"none"},"equipment":{"ventilators":2},"resources":{"asv":{"quantity":4,"updated_at":"2026-10-17T05:00:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000010', 'Demo Referral Hospital 10', 'Sector 12, Noida', 'Sector 12', 'Noida', 'Government', 28.5729, 77.3256, ARRAY['General Medicine','Toxicology'], 22, 8, 7, ARRAY['Dr. L (Tox)'], '{"A+":4,"B+":3,"O+":5}', true, 6, '{"hospital_id":"h10","ownership":"Government","beds":{"total":300,"icu":22},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":7},"resources":{"asv":{"quantity":22,"updated_at":"2026-10-17T10:30:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000011', 'Demo City Hospital 11', 'Sector 62, Noida', 'Sector 62', 'Noida', 'Private', 28.6274, 77.3646, ARRAY['General Medicine','ENT'], 14, 4, 4, ARRAY['Dr. M (ENT)'], '{"A+":2,"B+":2,"O+":3}', true, 8, '{"hospital_id":"h11","ownership":"Private","beds":{"total":160,"icu":14},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":4},"resources":{"asv":{"quantity":6,"updated_at":"2026-10-17T08:50:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000012', 'Demo District Hospital 12', 'Sector Alpha, Greater Noida', 'Sector Alpha', 'Greater Noida', 'Government', 28.4744, 77.5040, ARRAY['General Medicine','Toxicology'], 16, 6, 5, ARRAY['Dr. N (Tox)'], '{"A+":2,"B+":2,"O+":4}', true, 5, '{"hospital_id":"h12","ownership":"Government","beds":{"total":200,"icu":16},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":5},"resources":{"asv":{"quantity":12,"updated_at":"2026-10-17T09:55:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000013', 'Demo Medical Centre 13', 'Vasundhara, Ghaziabad', 'Vasundhara', 'Ghaziabad', 'Private', 28.6652, 77.3604, ARRAY['General Medicine'], 10, 3, 3, ARRAY['Dr. O (Gen)'], '{"A+":1,"B+":1,"O+":3}', true, 10, '{"hospital_id":"h13","ownership":"Private","beds":{"total":140,"icu":10},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":3},"resources":{"asv":{"quantity":9,"updated_at":"2026-10-17T07:20:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000014', 'Demo Govt Medical College 14', 'Civil Lines, Ghaziabad', 'Civil Lines', 'Ghaziabad', 'Government', 28.6694, 77.4378, ARRAY['General Medicine','Toxicology','Nephrology'], 35, 14, 10, ARRAY['Dr. P (Tox)','Dr. Q (Nephro)'], '{"A+":6,"B+":5,"O+":8}', true, 7, '{"hospital_id":"h14","ownership":"Government","beds":{"total":500,"icu":35},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":10},"resources":{"asv":{"quantity":28,"updated_at":"2026-10-17T10:40:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000015', 'Demo Super Speciality 15', 'Sector 44, Gurugram', 'Sector 44', 'Gurugram', 'Private', 28.4595, 77.0266, ARRAY['General Medicine','Toxicology','Pulmonology'], 28, 11, 11, ARRAY['Dr. R (Tox)','Dr. S (Pulmo)'], '{"A+":5,"B+":4,"O+":7}', true, 6, '{"hospital_id":"h15","ownership":"Private","beds":{"total":280,"icu":28},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":11},"resources":{"asv":{"quantity":20,"updated_at":"2026-10-17T10:05:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000016', 'Demo District Hospital 16', 'Sector 10, Gurugram', 'Sector 10', 'Gurugram', 'Government', 28.4472, 77.0708, ARRAY['General Medicine'], 18, 6, 6, ARRAY['Dr. T (Gen)'], '{"A+":3,"B+":3,"O+":4}', true, 9, '{"hospital_id":"h16","ownership":"Government","beds":{"total":240,"icu":18},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":6},"resources":{"asv":{"quantity":0,"updated_at":"2026-10-17T06:10:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000017', 'Demo Community Hospital 17', 'Old Faridabad, Faridabad', 'Old Faridabad', 'Faridabad', 'Government', 28.4088, 77.3178, ARRAY['General Medicine'], 12, 4, 4, ARRAY['Dr. U (Gen)'], '{"A+":2,"B+":2,"O+":3}', true, 11, '{"hospital_id":"h17","ownership":"Government","beds":{"total":180,"icu":12},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":4},"resources":{"asv":{"quantity":7,"updated_at":"2026-10-16T18:30:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000018', 'Demo Apex Institute 18', 'Sector 21, Faridabad', 'Sector 21', 'Faridabad', 'Government', 28.3799, 77.3155, ARRAY['General Medicine','Toxicology','Trauma'], 50, 22, 14, ARRAY['Dr. V (Tox)','Dr. W (Trauma)'], '{"A+":8,"B+":6,"O+":10}', true, 4, '{"hospital_id":"h18","ownership":"Government","beds":{"total":720,"icu":50},"capabilities":{"emergency":true,"toxicology":"24x7"},"equipment":{"ventilators":14},"resources":{"asv":{"quantity":35,"updated_at":"2026-10-17T10:45:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000019', 'Demo Trust Hospital 19', 'Model Town, New Delhi', 'Model Town', 'New Delhi', 'Private', 28.7145, 77.1936, ARRAY['General Medicine','Dermatology'], 10, 3, 2, ARRAY['Dr. X (Gen)'], '{"A+":1,"B+":1,"O+":2}', false, 3, '{"hospital_id":"h19","ownership":"Private","beds":{"total":120,"icu":10},"capabilities":{"emergency":false,"toxicology":"none"},"equipment":{"ventilators":2},"resources":{"asv":{"quantity":3,"updated_at":"2026-10-17T04:15:00Z"}}}'::jsonb),
  ('00000000-0000-4000-8000-000000000020', 'Demo Cantonment Hospital 20', 'Delhi Cantonment, New Delhi', 'Delhi Cantonment', 'New Delhi', 'Government', 28.6062, 77.1412, ARRAY['General Medicine','Toxicology'], 20, 7, 5, ARRAY['Dr. Y (Tox)'], '{"A+":3,"B+":2,"O+":5}', true, 5, '{"hospital_id":"h20","ownership":"Government","beds":{"total":260,"icu":20},"capabilities":{"emergency":true,"toxicology":"day only"},"equipment":{"ventilators":5},"resources":{"asv":{"quantity":11,"updated_at":"2026-10-17T09:30:00Z"}}}'::jsonb);

-- ============ 9. SEED: ASV stock ============
INSERT INTO asv_stock (hospital_id, batch_code, quantity, expiry_date, product, updated_at, updated_by) VALUES
  ('00000000-0000-4000-8000-000000000001', 'DEMO-ASV-h001', 25, '2027-03-31', 'Polyvalent ASV', '2026-10-17T09:40:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000002', 'DEMO-ASV-h002', 40, '2027-03-31', 'Polyvalent ASV', '2026-10-17T10:20:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000003', 'DEMO-ASV-h003', 10, '2027-03-31', 'Polyvalent ASV', '2026-10-17T08:05:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000004', 'DEMO-ASV-h004', 5, '2027-03-31', 'Polyvalent ASV', '2026-10-17T07:45:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000005', 'DEMO-ASV-h005', 15, '2027-03-31', 'Polyvalent ASV', '2026-10-17T10:55:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000007', 'DEMO-ASV-h007', 8, '2027-03-31', 'Polyvalent ASV', '2026-10-16T20:00:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000008', 'DEMO-ASV-h008', 18, '2027-03-31', 'Polyvalent ASV', '2026-10-17T09:10:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000009', 'DEMO-ASV-h009', 4, '2027-03-31', 'Polyvalent ASV', '2026-10-17T05:00:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000010', 'DEMO-ASV-h010', 22, '2027-03-31', 'Polyvalent ASV', '2026-10-17T10:30:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000011', 'DEMO-ASV-h011', 6, '2027-03-31', 'Polyvalent ASV', '2026-10-17T08:50:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000012', 'DEMO-ASV-h012', 12, '2027-03-31', 'Polyvalent ASV', '2026-10-17T09:55:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000013', 'DEMO-ASV-h013', 9, '2027-03-31', 'Polyvalent ASV', '2026-10-17T07:20:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000014', 'DEMO-ASV-h014', 28, '2027-03-31', 'Polyvalent ASV', '2026-10-17T10:40:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000015', 'DEMO-ASV-h015', 20, '2027-03-31', 'Polyvalent ASV', '2026-10-17T10:05:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000017', 'DEMO-ASV-h017', 7, '2027-03-31', 'Polyvalent ASV', '2026-10-16T18:30:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000018', 'DEMO-ASV-h018', 35, '2027-03-31', 'Polyvalent ASV', '2026-10-17T10:45:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000019', 'DEMO-ASV-h019', 3, '2027-03-31', 'Polyvalent ASV', '2026-10-17T04:15:00Z', 'hospital_desk'),
  ('00000000-0000-4000-8000-000000000020', 'DEMO-ASV-h020', 11, '2027-03-31', 'Polyvalent ASV', '2026-10-17T09:30:00Z', 'hospital_desk');

-- ============ 10. SEED: staff password hashes + hospital link ============
UPDATE staff_users SET password_hash = encode(sha256(('swasthya-demo-salt:' || 'demo123')::bytea), 'hex')
WHERE password_hash IS NULL OR password_hash = '';

UPDATE staff_users SET hospital_id = '00000000-0000-4000-8000-000000000002' WHERE username = 'admin1';

ALTER TABLE staff_users DROP COLUMN IF EXISTS password;
