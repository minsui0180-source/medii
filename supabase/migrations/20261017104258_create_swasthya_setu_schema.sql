/*
# Swasthya Setu — demo schema

1. New Tables
   - `hospitals` — 6 mock Delhi-NCR hospitals with coordinates, specialties, ICU/ventilator capacity, blood stock, emergency capability.
   - `patients` — 2 mock ABHA patients with prior conditions, medicines, past visits, and an OCR'd prescription (DEMO DATA).
   - `queue_entries` — one row per OPD intake (green/yellow path): transcript, triage, summary, source tags, OCR records, token, priority, status.
   - `emergency_requests` — red-path requests with live broadcast status, accepted/declined hospital records, and decline reasons.
   - `audit_log` — every record access / override / queue change (timestamp, role, action, patient id).
   - `staff_users` — 3 mock demo logins (doctor, reception, admin) for role-based dashboards.
2. Security
   - RLS enabled on all tables. No sign-in screen, so policies are `TO anon, authenticated` (intentionally public demo data, documented here).
   - Role enforcement (doctor-only clinical data) is done in the edge function layer, not in RLS, because staff auth is mocked.
3. Notes
   - All data is seeded mock/demo data for a hackathon prototype. Queue priority = triage base + waiting points, computed in app.
*/

CREATE TABLE IF NOT EXISTS hospitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  specialties text[] NOT NULL DEFAULT '{}',
  icu_beds_total int NOT NULL DEFAULT 0,
  icu_beds_available int NOT NULL DEFAULT 0,
  ventilators_available int NOT NULL DEFAULT 0,
  specialists_on_duty text[] NOT NULL DEFAULT '{}',
  blood_stock jsonb NOT NULL DEFAULT '{}'::jsonb,
  emergency_capable boolean NOT NULL DEFAULT false,
  queue_length int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  abha_id text UNIQUE NOT NULL,
  name text NOT NULL,
  phone text,
  age int,
  gender text,
  conditions text[] NOT NULL DEFAULT '{}',
  medicines text[] NOT NULL DEFAULT '{}',
  past_visits text[] NOT NULL DEFAULT '{}',
  ocr_prescriptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_label text NOT NULL,
  abha_id text,
  phone text,
  language text NOT NULL DEFAULT 'en-IN',
  transcript text NOT NULL DEFAULT '',
  followup_answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  triage_level text NOT NULL DEFAULT 'ROUTINE' CHECK (triage_level IN ('ROUTINE','URGENT','EMERGENCY')),
  summary jsonb,
  source_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  prior_history jsonb,
  ocr_records jsonb NOT NULL DEFAULT '[]'::jsonb,
  hospital_id uuid REFERENCES hospitals(id),
  token text NOT NULL,
  priority_score int NOT NULL DEFAULT 20,
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','SENT_TO_DOCTOR','IN_CONSULT','DONE')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS emergency_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'WALKIN' CHECK (kind IN ('WALKIN','ABHA_FAMILY')),
  patient_label text NOT NULL,
  abha_id text,
  phone text,
  language text NOT NULL DEFAULT 'en-IN',
  lat double precision,
  lng double precision,
  answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  emergency_summary jsonb,
  status text NOT NULL DEFAULT 'BROADCASTING' CHECK (status IN ('BROADCASTING','ACCEPTED','DECLINED_ALL')),
  current_target_index int NOT NULL DEFAULT 0,
  responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted_hospital_id uuid REFERENCES hospitals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  role text NOT NULL,
  action text NOT NULL,
  patient_ref text NOT NULL DEFAULT '',
  details jsonb
);

CREATE TABLE IF NOT EXISTS staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password text NOT NULL,
  role text NOT NULL CHECK (role IN ('DOCTOR','RECEPTION','ADMIN')),
  display_name text NOT NULL
);

ALTER TABLE hospitals ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read hospitals" ON hospitals;
CREATE POLICY "public read hospitals" ON hospitals FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public update hospitals" ON hospitals;
CREATE POLICY "public update hospitals" ON hospitals FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public read patients" ON patients;
CREATE POLICY "public read patients" ON patients FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public read queue" ON queue_entries;
CREATE POLICY "public read queue" ON queue_entries FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public insert queue" ON queue_entries;
CREATE POLICY "public insert queue" ON queue_entries FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public update queue" ON queue_entries;
CREATE POLICY "public update queue" ON queue_entries FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public read emergencies" ON emergency_requests;
CREATE POLICY "public read emergencies" ON emergency_requests FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public insert emergencies" ON emergency_requests;
CREATE POLICY "public insert emergencies" ON emergency_requests FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public update emergencies" ON emergency_requests;
CREATE POLICY "public update emergencies" ON emergency_requests FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public read audit" ON audit_log;
CREATE POLICY "public read audit" ON audit_log FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public insert audit" ON audit_log;
CREATE POLICY "public insert audit" ON audit_log FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "public read staff" ON staff_users;
CREATE POLICY "public read staff" ON staff_users FOR SELECT TO anon, authenticated USING (true);

INSERT INTO hospitals (name, address, lat, lng, specialties, icu_beds_total, icu_beds_available, ventilators_available, specialists_on_duty, blood_stock, emergency_capable, queue_length) VALUES
  ('Demo District Hospital A', 'Sector 12, New Delhi', 28.6139, 77.2090, ARRAY['General Medicine','Cardiology','Orthopaedics'], 20, 4, 3, ARRAY['Dr. Rao (Cardio)','Dr. Iyer (Gen)'], '{"A+":6,"B+":4,"O+":8,"AB+":2,"O-":1}', true, 12),
  ('Demo Metropolitan Hospital B', 'Rohini Sector 7, New Delhi', 28.7495, 77.0565, ARRAY['General Medicine','Paediatrics','Neurology'], 35, 9, 6, ARRAY['Dr. Sen (Neuro)','Dr. Kaur (Paed)'], '{"A+":10,"B+":7,"O+":12,"AB+":3,"O-":2}', true, 7),
  ('Demo City Care Hospital C', 'Sector 62, Noida', 28.6274, 77.3646, ARRAY['General Medicine','Orthopaedics','ENT'], 12, 1, 1, ARRAY['Dr. Mehta (Ortho)'], '{"A+":2,"B+":3,"O+":5,"AB+":1,"O-":0}', true, 21),
  ('Demo Riverside Multispeciality D', 'Vasundhara, Ghaziabad', 28.6652, 77.3604, ARRAY['General Medicine','Cardiology','Nephrology'], 25, 6, 4, ARRAY['Dr. Rao (Cardio)','Dr. Bose (Nephro)'], '{"A+":5,"B+":6,"O+":9,"AB+":2,"O-":1}', true, 15),
  ('Demo Sunrise Trauma Centre E', 'Sector 44, Gurugram', 28.4595, 77.0266, ARRAY['Trauma','General Medicine','Pulmonology'], 18, 7, 5, ARRAY['Dr. Nair (Pulmo)','Dr. Shah (Trauma)'], '{"A+":4,"B+":5,"O+":7,"AB+":4,"O-":3}', true, 5),
  ('Demo Green Park Clinic F', 'Green Park, New Delhi', 28.5582, 77.2050, ARRAY['General Medicine','Dermatology','Diabetology'], 6, 2, 0, ARRAY['Dr. Kapoor (Gen)'], '{"A+":1,"B+":2,"O+":3,"AB+":1,"O-":0}', false, 9)
ON CONFLICT DO NOTHING;

INSERT INTO patients (abha_id, name, phone, age, gender, conditions, medicines, past_visits, ocr_prescriptions) VALUES
  ('91-1234-5678-9012', 'Ramesh Kumar', '+91 98110 11111', 54, 'M',
    ARRAY['Type 2 Diabetes','Hypertension'],
    ARRAY['Metformin 500mg (twice daily)','Telmisartan 40mg (once daily)'],
    ARRAY['2025-06-12: General Medicine — diabetes review','2025-11-03: Cardiology — BP follow-up'],
    '[{"file":"prescription_jun.jpg","date":"2025-06-12","medicines":[{"name":"Metformin","dosage":"500mg twice daily","ocr_confidence":96,"needs_review":false},{"name":"Telmisartan","dosage":"40mg once daily","ocr_confidence":91,"needs_review":false}]}]'::jsonb),
  ('91-8812-0000-1111', 'Sunita Devi', '+91 98110 22222', 38, 'F',
    ARRAY['Asthma','Anaemia (mild)'],
    ARRAY['Salbutamol inhaler (as needed)','Ferrous sulphate (once daily)'],
    ARRAY['2025-09-18: Pulmonology — asthma review'],
    '[{"file":"prescription_sep.jpg","date":"2025-09-18","medicines":[{"name":"Salbutamol inhaler","dosage":"2 puffs as needed","ocr_confidence":78,"needs_review":true},{"name":"Ferrous sulphate","dosage":"100mg once daily","ocr_confidence":88,"needs_review":false}]}]'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO staff_users (username, password, role, display_name) VALUES
  ('doctor1', 'demo123', 'DOCTOR', 'Dr. Anil Verma'),
  ('reception1', 'demo123', 'RECEPTION', 'Priya (Reception)'),
  ('admin1', 'demo123', 'ADMIN', 'Admin — Demo Metropolitan Hospital B')
ON CONFLICT DO NOTHING;
