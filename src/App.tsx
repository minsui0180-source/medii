import { useCallback, useEffect, useState } from 'react';
import { Phone, Ambulance, ArrowLeft } from 'lucide-react';
import type { LangCode, Hospital, OcrRecord, IntakeResult, StaffUser, PatientRecord } from '@/types';
import { patientLookup, queueSubmit, hospitalsList, type QueueSubmitResult } from '@/lib/api';
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
  patient: { name: string; abhaId: string | null; prior: PatientRecord | null };
  hospital: Hospital | null;
  submitted: QueueSubmitResult | null;
  intake: IntakeResult | null;
  ocr: OcrRecord[];
}

export default function App() {
  const [entry, setEntry] = useState<EntryResult | null>(null);
  const [green, setGreen] = useState<GreenState | null>(null);
  const [escalation, setEscalation] = useState<string | null>(null);
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null);
  const [staffLoginOpen, setStaffLoginOpen] = useState(false);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);

  const lang: LangCode = entry?.lang ?? 'en-IN';

  useEffect(() => {
    if (!entry) return;
    hospitalsList().then((d) => setHospitals(d.hospitals ?? [])).catch(() => undefined);
  }, [entry]);

  const start = useCallback((r: EntryResult) => {
    setEntry(r);
    setEscalation(null);
    if (r.path === 'STAFF') {
      setStaffLoginOpen(true);
    } else if (r.path === 'RED') {
      setGreen(null);
    } else {
      setGreen({ stage: 'ABHA', patient: { name: '', abhaId: null, prior: null }, hospital: null, submitted: null, intake: null, ocr: [] });
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
  const [lookupBusy, setLookupBusy] = useState(false);

  async function lookupAbha() {
    const id = abhaInput.trim();
    if (!/^91-\d{4}-\d{4}-\d{4}$/.test(id)) {
      setAbhaError(t(lang, 'abhaHint'));
      return;
    }
    setAbhaError('');
    setLookupBusy(true);
    try {
      const { patient } = await patientLookup(id);
      setGreen((g) => (g ? { ...g, patient: { name: patient?.name ?? 'New patient', abhaId: id, prior: patient }, stage: 'HOSPITAL' } : g));
    } catch (e) {
      setAbhaError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setLookupBusy(false);
    }
  }

  function continueAsNew() {
    if (!/^\+?\d{10,13}$/.test(phoneInput.replace(/\s/g, ''))) {
      setAbhaError(t(lang, 'phonePlaceholder'));
      return;
    }
    setGreen((g) => (g ? { ...g, patient: { name: t(lang, 'anonymous'), abhaId: null, prior: null }, stage: 'HOSPITAL' } : g));
  }

  async function submitQueue(intake: IntakeResult, transcript: string, answers: { question: string; answer: string }[], ocr: OcrRecord[]) {
    if (!green || !entry || !green.hospital) return;
    try {
      const result = await queueSubmit({
        language: entry.lang,
        abha_id: green.patient.abhaId ?? undefined,
        phone: phoneInput || undefined,
        hospital_id: green.hospital.id,
        triage_floor: entry.path === 'YELLOW' ? 'URGENT' : 'ROUTINE',
        transcript,
        followup_answers: answers,
        intake,
        prior_history: green.patient.prior ?? undefined,
        ocr_records: ocr,
      });
      setGreen((g) => (g ? { ...g, stage: 'QUEUE', submitted: result, intake } : g));
    } catch {
      setEscalation('');
    }
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
        <RedPath lang={lang} location={entry.location} />
      </div>
    );
  }

  // GREEN / YELLOW
  if (!green) return null;

  if (escalation !== null) {
    return (
      <div className="min-h-screen bg-red-700 flex flex-col items-center justify-center p-6 text-center">
        <Ambulance className="w-16 h-16 text-white mb-4 pulse-red rounded-full p-2" />
        <h1 className="text-3xl font-bold text-white mb-2">{t(lang, 'escalationTitle')}</h1>
        {escalation && <p className="text-red-100 mb-6">{escalation}</p>}
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
            <button onClick={lookupAbha} disabled={lookupBusy} className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50">
              {t(lang, 'continue')}
            </button>
            <button onClick={() => setNewPatientMode(true)} className="w-full text-sm text-emerald-800 underline py-1">
              {t(lang, 'noAbha')}
            </button>
            {newPatientMode && (
              <div className="space-y-2 border-t border-emerald-100 pt-3">
                <input
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder={t(lang, 'phonePlaceholder')}
                  inputMode="tel"
                  className="w-full border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
                />
                <button onClick={continueAsNew} className="btn-touch w-full bg-emerald-600 text-white">
                  {t(lang, 'continueAsNew')}
                </button>
              </div>
            )}
          </div>
          {green.patient.prior && (
            <div className="card p-4 space-y-1 text-sm">
              <h3 className="font-bold text-emerald-900">{t(lang, 'priorRecords')}</h3>
              <p className="text-emerald-800">{t(lang, 'conditions')}: {green.patient.prior.conditions.join(', ') || '—'}</p>
              <p className="text-emerald-800">{t(lang, 'medicines')}: {green.patient.prior.medicines.join(', ') || '—'}</p>
            </div>
          )}
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
          location={entry.location ?? { lat: 28.6139, lng: 77.209 }}
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
          triageFloor={entry.path === 'YELLOW' ? 'URGENT' : 'ROUTINE'}
          prior={green.patient.prior}
          onEscalate={(reason) => setEscalation(reason)}
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
        submitted={green.submitted!}
        hospitalName={green.hospital?.name ?? ''}
        intake={green.intake!}
        onStaffLogin={() => setStaffLoginOpen(true)}
      />
    </div>
  );
}
