// Swasthya Setu — shared UI types. API response types live in lib/api.ts.

export type TriageLevel = 'ROUTINE' | 'URGENT' | 'EMERGENCY';
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

export type { Hospital, IntakeResult, IntakeSummary, OcrMedicine, OcrRecord, PatientRecord, QueueRow, StaffUser, QueueStatusResult } from '@/lib/api';