// Swasthya Setu — shared types (frontend + edge function contract)

export type TriageLevel = 'ROUTINE' | 'URGENT' | 'EMERGENCY';
export type StaffRole = 'DOCTOR' | 'RECEPTION' | 'ADMIN';
export type LangCode = 'en-IN' | 'hi-IN' | 'ta-IN' | 'bn-IN' | 'mr-IN' | 'te-IN';

export interface LanguageOption {
  code: LangCode;
  label: string;
  native: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en-IN', label: 'English', native: 'English' },
  { code: 'hi-IN', label: 'Hindi', native: 'हिन्दी' },
  { code: 'ta-IN', label: 'Tamil', native: 'தமிழ்' },
  { code: 'bn-IN', label: 'Bengali', native: 'বাংলা' },
  { code: 'mr-IN', label: 'Marathi', native: 'मराठी' },
  { code: 'te-IN', label: 'Telugu', native: 'తెలుగు' },
];

export interface Hospital {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  specialties: string[];
  icu_beds_total: number;
  icu_beds_available: number;
  ventilators_available: number;
  specialists_on_duty: string[];
  blood_stock: Record<string, number>;
  emergency_capable: boolean;
  queue_length: number;
}

export interface OcrMedicine {
  name: string;
  dosage: string;
  ocr_confidence: number;
  needs_review: boolean;
}

export interface OcrRecord {
  file: string;
  date: string;
  medicines: OcrMedicine[];
  header?: string;
  warnings?: string[];
  raw_text?: string;
}

export interface Patient {
  id: string;
  abha_id: string;
  name: string;
  phone: string | null;
  age: number | null;
  gender: string | null;
  conditions: string[];
  medicines: string[];
  past_visits: string[];
  ocr_prescriptions: OcrRecord[];
}

export interface SourceTag {
  claim: string;
  source: 'voice' | 'history' | 'ocr';
}

export interface IntakeSummary {
  chief_complaint: string;
  duration: string;
  severity: number;
  relevant_history: string[];
}

export interface IntakeResult {
  triage_level: TriageLevel;
  emergency_reason: string | null;
  summary: IntakeSummary;
  source_tags: SourceTag[];
  followup_questions: string[];
  mock: boolean;
}

export interface QueueEntry {
  id: string;
  patient_label: string;
  abha_id: string | null;
  phone: string | null;
  language: string;
  transcript: string;
  followup_answers: { question: string; answer: string }[];
  triage_level: TriageLevel;
  summary: IntakeSummary | null;
  source_tags: SourceTag[];
  prior_history: {
    conditions: string[];
    medicines: string[];
    past_visits: string[];
    ocr_prescriptions: OcrRecord[];
  } | null;
  ocr_records: OcrRecord[];
  hospital_id: string | null;
  token: string;
  priority_score: number;
  status: 'WAITING' | 'SENT_TO_DOCTOR' | 'IN_CONSULT' | 'DONE';
  created_at: string;
}

export interface EmergencyResponse {
  hospital_id: string;
  hospital_name: string;
  action: 'ACCEPT' | 'DECLINE';
  reason?: string;
  at: string;
}

export interface EmergencyRequest {
  id: string;
  kind: 'WALKIN' | 'ABHA_FAMILY';
  patient_label: string;
  abha_id: string | null;
  phone: string | null;
  language: string;
  lat: number | null;
  lng: number | null;
  answers: { question: string; answer: string }[];
  emergency_summary: IntakeResult | null;
  status: 'BROADCASTING' | 'ACCEPTED' | 'DECLINED_ALL';
  current_target_index: number;
  responses: EmergencyResponse[];
  accepted_hospital_id: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  ts: string;
  role: string;
  action: string;
  patient_ref: string;
  details: Record<string, unknown> | null;
}

export interface StaffUser {
  id: string;
  username: string;
  role: StaffRole;
  display_name: string;
}

export interface HospitalQueueState {
  hospitals: Hospital[];
  queue: QueueEntry[];
  requests: EmergencyRequest[];
}
