import { useCallback, useEffect, useState } from 'react';
import { Phone, Ambulance, ArrowLeft } from 'lucide-react';
import type { LangCode, Hospital, OcrRecord, Patient, IntakeResult, StaffUser } from '@/types';
import { supabase } from '@/lib/supabase';
import { formatToken } from '@/lib/helpers';
import { Header } from '@/components/Chrome';
import { EntryScreen, type EntryResult } from '@/screens/EntryScreen';
import { RedPath } from '@/screens/RedPath';
import { HospitalChooser } from '@/screens/HospitalChooser';
import { VoiceIntake } from '@/screens/VoiceIntake';
import { QueueStatus } from '@/screens/QueueStatus';
import { StaffLogin, StaffDashboard } from '@/screens/StaffDashboard';
import { t } from '@/lib/i18n';

interface GreenState {
  stage: 'ABHA' | 'HOSPITAL' | 'INTAKE' | 'QUEUE';
  patient: { name: string; abhaId: string | null; prior: { conditions: string[]; medicines: string[]; past_visits: string[]; ocr_prescriptions: OcrRecord[] } | null };
  hospital: Hospital | null;
  token: string;
  entryId: string;
  intake: IntakeResult | null;
  ocr: OcrRecord[];
}

interface Escalation {
  reason: string;
}

export default function App() {
  const [entry, setEntry] = useState<EntryResult | null>(null);
  const [green, setGreen] = useState<GreenState | null>(null);
  const [escalation, setEscalation] = useState<Escalation | null>(null);
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null);
  const [staffLoginOpen, setStaffLoginOpen] = useState(false);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);

  const lang: LangCode = entry?.lang ?? 'en-IN';

  useEffect(() => {
    supabase.from('hospitals').select('*').then(({ data }) => setHospitals((data as Hospital[]) ?? []));
  }, []);

  const start = useCallback((r: EntryResult) => {
    setEntry(r);
    setEscalation(null);
    if (r.path === 'STAFF') {
      setStaffLoginOpen(true);
    } else if (r.path === 'RED') {
      setGreen(null);
    } else {
      setGreen({ stage: 'ABHA', patient: { name: '', abhaId: null, prior: null }, hospital: null, token: '', entryId: '', intake: null, ocr: [] });
    }
  }, []);

  function home() {
    setEntry(null);
    setGreen(null);
    setStaffUser(null);
    setStaffLoginOpen(false);
    setEscalation(null);
  }

  // ---- ABHA step ----
  const [abhaInput, setAbhaInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [abhaError, setAbhaError] = useState('');
  const [newPatientMode, setNewPatientMode] = useState(false);

  async function lookupAbha() {
    const id = abhaInput.trim();
    if (!/^91-\d{4}-\d{4}-\d{4}$/.test(id)) {
      setAbhaError(t(lang, 'abhaHint'));
      return;
    }
    setAbhaError('');
    const { data } = await supabase.from('patients').select('*').eq('abha_id', id).maybeSingle();
    const p = data as Patient | null;
    setGreen((g) =>
      g
        ? {
            ...g,
            patient: {
              name: p?.name ?? 'New patient',
              abhaId: id,
              prior: p
                ? {
                    conditions: p.conditions,
                    medicines: p.medicines,
                    past_visits: p.past_visits,
                    ocr_prescriptions: p.ocr_prescriptions,
                  }
                : null,
            },
            stage: 'HOSPITAL',
          }
        : g,
    );
  }

  function continueAsNew() {
    if (!phoneInput.trim()) {
      setAbhaError(t(lang, 'phonePlaceholder'));
      return;
    }
    setGreen((g) => (g ? { ...g, patient: { name: t(lang, 'anonymous'), abhaId: null, prior: null }, stage: 'HOSPITAL' } : g));
  }

  async function submitQueue(intake: IntakeResult, transcript: string, answers: { question: string; answer: string }[], ocr: OcrRecord[]) {
    if (!green || !entry || !green.hospital) return;
    // priority: EMERGENCY 100, URGENT 60, ROUTINE 20 (+ up to 20 waiting, set later by sort)
    const base = intake.triage_level === 'EMERGENCY' ? 100 : intake.triage_level === 'URGENT' ? 60 : 20;
    const { count } = await supabase.from('queue_entries').select('*', { count: 'exact', head: true });
    const token = formatToken((count ?? 0) + 1);
    const { data, error } = await supabase
      .from('queue_entries')
      .insert({
        patient_label: green.patient.name,
        abha_id: green.patient.abhaId,
        phone: phoneInput || null,
        language: entry.lang,
        transcript,
        followup_answers: answers,
        triage_level: intake.triage_level,
        summary: intake.summary,
        source_tags: intake.source_tags,
        prior_history: green.patient.prior,
        ocr_records: ocr,
        hospital_id: green.hospital.id,
        token,
        priority_score: base,
        status: 'SENT_TO_DOCTOR',
      })
      .select()
      .single();
    if (error || !data) return;
    setGreen((g) => (g ? { ...g, stage: 'QUEUE', token, entryId: (data as { id: string }).id, intake } : g));
  }

  // ---- render ----
  if (!entry) {
    return (
      <div className="min-h-screen">
        <Header lang="en-IN" onHome={home} />
        <EntryScreen onStart={start} />
      </div>
    );
  }

  if (staffUser) {
    return (
      <div className="min-h-screen">
        <Header lang={lang} onHome={home} />
        <StaffDashboard lang={lang} user={staffUser} onLogout={() => { setStaffUser(null); setStaffLoginOpen(true); }} />
      </div>
    );
  }

  if (staffLoginOpen) {
    return (
      <div className="min-h-screen">
        <Header lang={lang} onHome={home} />
        <StaffLogin lang={lang} onLoggedIn={setStaffUser} onBack={home} />
      </div>
    );
  }

  if (entry.path === 'RED') {
    return (
      <div className="min-h-screen">
        <Header lang={lang} onHome={home} />
        <RedPath lang={lang} location={entry.location!} onStaffLogin={() => setStaffLoginOpen(true)} />
      </div>
    );
  }

  // GREEN / YELLOW
  if (!green) return null;

  if (escalation) {
    return (
      <div className="min-h-screen bg-red-700 flex flex-col items-center justify-center p-6 text-center">
        <Ambulance className="w-16 h-16 text-white mb-4 pulse-red rounded-full p-2" />
        <h1 className="text-3xl font-bold text-white mb-2">{t(lang, 'escalationTitle')}</h1>
        <p className="text-red-100 mb-6">{escalation.reason}</p>
        <button
          onClick={() => { setEntry({ ...entry, path: 'RED' }); setEscalation(null); }}
          className="btn-touch !min-h-[88px] !text-2xl w-full max-w-sm bg-white text-red-700 flex items-center justify-center gap-3 mb-3"
        >
          <Ambulance className="w-8 h-8" /> {t(lang, 'switchToRed')}
        </button>
        <a href="tel:108" className="btn-touch w-full max-w-sm bg-red-900 text-white flex items-center justify-center gap-2 mb-3">
          <Phone className="w-5 h-5" /> 108 / 112
        </a>
        <button onClick={() => setEscalation(null)} className="text-white underline text-sm flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> {t(lang, 'backToGreen')}
        </button>
      </div>
    );
  }

  if (green.stage === 'ABHA') {
    return (
      <div className="min-h-screen">
        <Header lang={lang} onHome={home} />
        <div className="max-w-md mx-auto px-4 py-6 space-y-4 fade-in">
          <div className="card p-5 space-y-3">
            <h2 className="text-xl font-bold text-emerald-900">{t(lang, 'abhaTitle')}</h2>
            <input
              value={abhaInput}
              onChange={(e) => setAbhaInput(e.target.value)}
              placeholder="91-1234-5678-9012"
              className="w-full border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[56px] focus:border-emerald-500 outline-none"
            />
            <p className="text-xs text-emerald-700">{t(lang, 'abhaHint')}</p>
            {abhaError && <p className="text-sm text-red-700">{abhaError}</p>}
            <button onClick={lookupAbha} className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white">
              {t(lang, 'continue')}
            </button>
            <button
              onClick={() => setNewPatientMode(true)}
              className="w-full text-sm text-emerald-800 underline py-1"
            >
              {t(lang, 'noAbha')}
            </button>
            {newPatientMode && (
              <div className="space-y-2 border-t border-emerald-100 pt-3">
                <input
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder={t(lang, 'phonePlaceholder')}
                  className="w-full border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
                />
                <button onClick={continueAsNew} className="btn-touch w-full bg-emerald-600 text-white">
                  {t(lang, 'continueAsNew')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (green.stage === 'HOSPITAL') {
    return (
      <div className="min-h-screen">
        <Header lang={lang} onHome={home} />
        <HospitalChooser
          lang={lang}
          location={entry.location!}
          hospitals={hospitals}
          selected={green.hospital?.id ?? null}
          onSelect={(id) => setGreen((g) => (g ? { ...g, hospital: hospitals.find((h) => h.id === id) ?? null } : g))}
          onNext={() => setGreen((g) => (g ? { ...g, stage: 'INTAKE' } : g))}
        />
      </div>
    );
  }

  if (green.stage === 'INTAKE') {
    return (
      <div className="min-h-screen">
        <Header lang={lang} onHome={home} />
        <VoiceIntake
          lang={lang}
          patient={green.patient}
          onEscalate={(reason) => setEscalation({ reason })}
          onDone={({ intake, transcript, answers, ocr }) => submitQueue(intake, transcript, answers, ocr)}
        />
      </div>
    );
  }

  // QUEUE
  return (
    <div className="min-h-screen">
      <Header lang={lang} onHome={home} />
      <QueueStatus
        lang={lang}
        token={green.token}
        hospitalName={green.hospital?.name ?? ''}
        entryId={green.entryId}
        intake={green.intake!}
        ocr={green.ocr}
        onStaffLogin={() => setStaffLoginOpen(true)}
      />
    </div>
  );
}
