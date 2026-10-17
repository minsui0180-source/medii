import { useEffect, useMemo, useState } from 'react';
import { Ambulance, Phone, MapPin, Loader2, CheckCircle2, XCircle, Clock, Users } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode, Hospital, EmergencyRequest, IntakeResult } from '@/types';
import { api, supabase } from '@/lib/supabase';
import { haversineKm } from '@/lib/helpers';
import { DemoBadge } from '@/components/Chrome';
import { OcrUploader } from '@/components/OcrUploader';

interface Props {
  lang: LangCode;
  location: { lat: number; lng: number };
  onStaffLogin: () => void;
}

type Stage = 'AMBULANCE' | 'DISPATCHED' | 'FAMILY_LOGIN' | 'FAMILY_QUESTIONS' | 'BROADCASTING' | 'ACCEPTED' | 'ALL_DECLINED';

const TIMEOUT_SECONDS = 90;

export function RedPath({ lang, location, onStaffLogin }: Props) {
  const [stage, setStage] = useState<Stage>('AMBULANCE');
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [request, setRequest] = useState<EmergencyRequest | null>(null);
  const [abha, setAbha] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(TIMEOUT_SECONDS);
  const [ocrDone, setOcrDone] = useState(false);

  useEffect(() => {
    supabase
      .from('hospitals')
      .select('*')
      .then(({ data }) => setHospitals((data as Hospital[]) ?? []));
  }, []);

  const emergencyHospitals = useMemo(
    () =>
      hospitals
        .filter((h) => h.emergency_capable)
        .map((h) => ({ h, km: haversineKm(location, h) }))
        .sort((a, b) => a.km - b.km),
    [hospitals, location],
  );

  // Live poll of the emergency request (realtime via channel would also work)
  useEffect(() => {
    if (!request || stage !== 'BROADCASTING') return;
    const ch = supabase
      .channel(`emg-${request.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'emergency_requests', filter: `id=eq.${request.id}` },
        (payload) => {
          const row = payload.new as EmergencyRequest;
          if (row.status === 'ACCEPTED') setStage('ACCEPTED');
          else if (row.status === 'DECLINED_ALL') setStage('ALL_DECLINED');
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [request, stage]);

  // Timeout cascade: countdown, then advance to next nearest hospital
  useEffect(() => {
    if (stage !== 'BROADCASTING' || !request) return;
    setSecondsLeft(TIMEOUT_SECONDS);
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(iv);
          advanceTarget();
          return TIMEOUT_SECONDS;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, request?.current_target_index]);

  async function advanceTarget() {
    if (!request) return;
    const next = request.current_target_index + 1;
    if (next >= emergencyHospitals.length) {
      await supabase.from('emergency_requests').update({ status: 'DECLINED_ALL' }).eq('id', request.id);
      setStage('ALL_DECLINED');
      return;
    }
    const { data } = await supabase
      .from('emergency_requests')
      .update({ current_target_index: next })
      .eq('id', request.id)
      .select()
      .single();
    if (data) setRequest(data as EmergencyRequest);
  }

  function callAmbulance() {
    // Demo: mock dispatch immediately, no login required
    setStage('DISPATCHED');
  }

  async function startFamilyRequest() {
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await supabase
        .from('emergency_requests')
        .insert({
          kind: 'WALKIN',
          patient_label: 'Family-reported emergency',
          abha_id: abha || null,
          lat: location.lat,
          lng: location.lng,
          language: lang,
        })
        .select()
        .single();
      if (e) throw e;
      setRequest(data as EmergencyRequest);
      setStage('FAMILY_QUESTIONS');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendBroadcast(summary: IntakeResult, answers: { question: string; answer: string }[]) {
    if (!request) return;
    setBusy(true);
    try {
      const { data, error: e } = await supabase
        .from('emergency_requests')
        .update({ emergency_summary: summary, answers, status: 'BROADCASTING' })
        .eq('id', request.id)
        .select()
        .single();
      if (e) throw e;
      setRequest(data as EmergencyRequest);
      setStage('BROADCASTING');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const target = request && emergencyHospitals[request.current_target_index];

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5 fade-in">
      {stage === 'AMBULANCE' && (
        <>
          <div className="card p-5 space-y-3 bg-red-50 border-red-200">
            <h2 className="text-2xl font-bold text-red-800">{t(lang, 'redTitle')}</h2>
            <p className="text-red-700">{t(lang, 'redNoLogin')}</p>
            <button
              onClick={callAmbulance}
              className="btn-touch !min-h-[112px] !text-2xl w-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center gap-3 pulse-red"
            >
              <Ambulance className="w-10 h-10" /> {t(lang, 'callAmbulance')}
            </button>
            <a
              href="tel:108"
              className="btn-touch w-full bg-white border-2 border-red-300 text-red-700 flex items-center justify-center gap-2"
            >
              <Phone className="w-5 h-5" /> {t(lang, 'call108')}
            </a>
          </div>

          <section className="card p-4 space-y-3">
            <h3 className="font-bold text-emerald-900 flex items-center gap-2">
              {t(lang, 'hospitalsNearby')} <DemoBadge />
            </h3>
            <ul className="space-y-2">
              {emergencyHospitals.slice(0, 3).map(({ h, km }) => (
                <li key={h.id} className="flex items-center justify-between text-sm border-b border-emerald-100 pb-2 last:border-0">
                  <span className="font-medium text-emerald-900">{h.name}</span>
                  <span className="text-emerald-700 flex items-center gap-1">
                    <MapPin className="w-4 h-4" /> {km.toFixed(1)} {t(lang, 'kmAway')}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-4 space-y-3">
            <h3 className="font-bold text-emerald-900">{t(lang, 'familyLogin')}</h3>
            <input
              value={abha}
              onChange={(e) => setAbha(e.target.value)}
              placeholder="91-1234-5678-9012"
              className="w-full border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
            />
            <button
              onClick={startFamilyRequest}
              disabled={busy}
              className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50"
            >
              {t(lang, 'familyIntro')}
            </button>
          </section>

          <OcrUploader lang={lang} onSaved={() => setOcrDone(true)} />
          {ocrDone && (
            <p className="text-sm text-emerald-700 flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" /> {t(lang, 'preArrival')}
            </p>
          )}
        </>
      )}

      {stage === 'DISPATCHED' && (
        <div className="card p-5 space-y-3 bg-emerald-50 border-emerald-200 fade-in">
          <h2 className="text-xl font-bold text-emerald-900 flex items-center gap-2">
            <Ambulance className="w-6 h-6" /> {t(lang, 'callAmbulance')} — {t(lang, 'status')}
          </h2>
          <div className="bg-white rounded-xl border border-emerald-200 p-3 text-sm space-y-1">
            <p className="font-semibold text-emerald-900">Ambulance dispatched (mock)</p>
            <p className="text-emerald-700 flex items-center gap-1">
              <MapPin className="w-4 h-4" /> {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
            </p>
            <p className="text-xs text-emerald-600">ETA ~9 min — DEMO DATA</p>
          </div>
          <ul className="space-y-2">
            {emergencyHospitals.slice(0, 3).map(({ h, km }) => (
              <li key={h.id} className="flex items-center justify-between text-sm border-b border-emerald-100 pb-2 last:border-0">
                <span className="font-medium text-emerald-900">{h.name}</span>
                <span className="text-emerald-700">{km.toFixed(1)} {t(lang, 'kmAway')}</span>
              </li>
            ))}
          </ul>
          <a href="tel:108" className="btn-touch w-full bg-red-600 text-white flex items-center justify-center gap-2">
            <Phone className="w-5 h-5" /> {t(lang, 'call108')}
          </a>
        </div>
      )}

      {stage === 'FAMILY_QUESTIONS' && (
        <FamilyQuestions lang={lang} onDone={(summary, answers) => sendBroadcast(summary, answers)} />
      )}

      {stage === 'BROADCASTING' && request && target && (
        <div className="card p-5 space-y-3 fade-in">
          <h2 className="text-xl font-bold text-red-800 flex items-center gap-2">
            <Clock className="w-6 h-6 animate-pulse" /> {t(lang, 'emergencyRequestSent')}
          </h2>
          <p className="text-emerald-800">{t(lang, 'waitingAccept')}</p>
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-1">
            <p className="font-bold text-red-900">{target.h.name}</p>
            <p className="text-sm text-red-700">{target.h.address}</p>
            <p className="text-sm font-semibold text-red-800">
              {t(lang, 'countdown')}: {secondsLeft}
              {t(lang, 'seconds')}
            </p>
          </div>
          <p className="text-xs text-emerald-600">{t(lang, 'keepRetrying')}</p>
          <a href="tel:108" className="btn-touch w-full bg-red-600 text-white flex items-center justify-center gap-2">
            <Phone className="w-5 h-5" /> {t(lang, 'noAcceptYet')}
          </a>
        </div>
      )}

      {stage === 'ACCEPTED' && request && (
        <div className="card p-5 space-y-3 bg-emerald-50 border-emerald-200 fade-in">
          <h2 className="text-xl font-bold text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6" /> {t(lang, 'acceptedBy')}
          </h2>
          {(() => {
            const h = hospitals.find((x) => x.id === request.accepted_hospital_id);
            return h ? (
              <div className="bg-white rounded-xl border border-emerald-200 p-3 text-sm">
                <p className="font-bold text-emerald-900">{h.name}</p>
                <p className="text-emerald-700">{h.address}</p>
              </div>
            ) : null;
          })()}
          <p className="text-sm text-emerald-800">{t(lang, 'preArrival')}</p>
        </div>
      )}

      {stage === 'ALL_DECLINED' && (
        <div className="card p-5 space-y-3 bg-red-50 border-red-300 fade-in">
          <h2 className="text-xl font-bold text-red-800 flex items-center gap-2">
            <XCircle className="w-6 h-6" /> {t(lang, 'noAcceptYet')}
          </h2>
          <a href="tel:108" className="btn-touch w-full bg-red-600 text-white flex items-center justify-center gap-2">
            <Phone className="w-5 h-5" /> 108 / 112
          </a>
          <button
            onClick={() => {
              if (request) {
                supabase.from('emergency_requests').update({ status: 'BROADCASTING', current_target_index: 0 }).eq('id', request.id);
                setStage('BROADCASTING');
              }
            }}
            className="btn-touch w-full bg-white border-2 border-red-300 text-red-700"
          >
            {t(lang, 'keepRetrying')}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
      <button onClick={onStaffLogin} className="w-full text-sm text-emerald-800 underline py-2 flex items-center justify-center gap-1">
        <Users className="w-4 h-4" /> {t(lang, 'doctorLogin')}
      </button>
    </div>
  );
}

// ---- family question flow ----
function FamilyQuestions({
  lang,
  onDone,
}: {
  lang: LangCode;
  onDone: (summary: IntakeResult, answers: { question: string; answer: string }[]) => void;
}) {
  const [desc, setDesc] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mock, setMock] = useState(false);

  const YN = [
    { en: 'Is the patient conscious and breathing?', choices: ['Yes', 'No'] },
    { en: 'Is there severe bleeding or chest pain?', choices: ['Yes', 'No'] },
    { en: 'Did the problem start suddenly?', choices: ['Yes', 'No'] },
    { en: 'Is the patient able to speak and walk?', choices: ['Yes', 'No'] },
    { en: 'Any known medicines or allergies?', choices: ['Yes', 'No', 'Not sure'] },
  ];

  async function analyze(finalAnswers: { question: string; answer: string }[]) {
    setBusy(true);
    setError('');
    try {
      const transcript = [desc, ...YN.map((q, i) => `${q.en}: ${finalAnswers[i]?.answer ?? ''}`)]
        .filter(Boolean)
        .join('. ');
      const data = await api<IntakeResult>('emergency-summary', { language: lang, transcript });
      setMock(Boolean(data.mock));
      onDone(data, finalAnswers);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  function answer(value: string) {
    const next = [...answers, { question: YN[qIndex].en, answer: value }];
    setAnswers(next);
    if (qIndex + 1 < YN.length) setQIndex(qIndex + 1);
    else analyze(next);
  }

  if (answers.length < YN.length) {
    const q = YN[qIndex];
    return (
      <div className="card p-5 space-y-4 fade-in">
        {busy && <Loader2 className="w-6 h-6 animate-spin text-emerald-700" />}
        <h2 className="text-lg font-bold text-emerald-900">
          {t(lang, 'familyIntro')} ({qIndex + 1}/{YN.length})
        </h2>
        <p className="text-lg font-medium text-emerald-900">{q.en}</p>
        <div className="grid grid-cols-2 gap-3">
          {q.choices.map((c) => (
            <button
              key={c}
              onClick={() => answer(c)}
              className={`btn-touch ${c === 'Yes' ? 'bg-emerald-600 text-white' : c === 'No' ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-950'}`}
            >
              {c === 'Yes' ? t(lang, 'yes') : c === 'No' ? t(lang, 'no') : c}
            </button>
          ))}
        </div>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t(lang, 'freeText')}
          rows={3}
          className="w-full border-2 border-emerald-200 rounded-xl px-3 py-2 focus:border-emerald-500 outline-none"
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  if (busy) {
    return (
      <div className="card p-5 flex items-center gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-700" /> {t(lang, 'loading')}
      </div>
    );
  }

  return (
    <div className="card p-5 space-y-3">
      <button onClick={() => analyze(answers)} className="btn-touch w-full bg-emerald-700 text-white">
        {t(lang, 'sendRequest')}
      </button>
      {mock && <p className="text-xs text-amber-800">{t(lang, 'aiMockNote')}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
