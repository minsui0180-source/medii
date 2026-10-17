import { useCallback, useEffect, useState } from 'react';
import { Ambulance, Phone, Loader2, MapPin, RotateCcw } from 'lucide-react';
import {
  emergencyCreate,
  emergencyStatus,
  emergencyRetry,
  emergencyAnswers,
  type EmergencyCreateResult,
  type EmergencyStatusResult,
  type IntakeResult,
} from '@/lib/api';
import type { LangCode } from '@/types';
import { t } from '@/lib/i18n';
import { formatClock } from '@/lib/helpers';
import { DemoBadge } from '@/components/Chrome';

const QUESTIONS = [
  'Is the patient conscious?',
  'Is the patient breathing normally?',
  'Is there heavy bleeding or chest pain?',
];

export function RedPath({ lang, location }: { lang: LangCode; location: { lat: number; lng: number } | null }) {
  const [step, setStep] = useState<'IDLE' | 'QUESTIONS' | 'SENT'>('IDLE');
  const [answers, setAnswers] = useState<Record<number, boolean>>({});
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<EmergencyCreateResult['candidates']>([]);
  const [status, setStatus] = useState<EmergencyStatusResult | null>(null);
  const [summary, setSummary] = useState<IntakeResult | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (step !== 'SENT') return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (!requestId) return;
      try {
        const s = await emergencyStatus(requestId);
        setStatus(s);
        if (s.status === 'DECLINED_ALL') await retry();
      } catch {
        /* keep polling */
      }
    }, 5000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, requestId]);

  const send = useCallback(
    async (withAnswers: boolean) => {
      setBusy(true);
      setError('');
      try {
        const created = await emergencyCreate({
          kind: 'ABHA_FAMILY',
          lat: location?.lat,
          lng: location?.lng,
          language: lang,
        });
        setRequestId(created.request_id);
        setCandidates(created.candidates ?? []);
        if (withAnswers) {
          const answerList = Object.entries(answers).map(([i, v]) => ({ question: QUESTIONS[Number(i)], answer: v ? 'Yes' : 'No' }));
          const { summary: s } = await emergencyAnswers({
            request_id: created.request_id,
            answers: answerList,
            free_text: freeText.trim() || undefined,
            language: lang,
          });
          setSummary(s);
        }
        setStatus(await emergencyStatus(created.request_id));
        setStep('SENT');
      } catch (e) {
        setError((e as Error).message || t(lang, 'errorGeneric'));
      } finally {
        setBusy(false);
      }
    },
    [answers, freeText, lang, location],
  );

  async function retry() {
    if (!requestId) return;
    try {
      await emergencyRetry(requestId);
    } catch {
      /* ignore */
    }
  }

  // ---- IDLE: big red button + optional family questions ----
  if (step === 'IDLE') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
        <DemoBadge />
        <h2 className="text-xl font-bold text-red-800">{t(lang, 'redTitle')}</h2>
        <p className="text-sm text-red-700">{t(lang, 'redNoLogin')}</p>

        <button
          onClick={() => send(false)}
          disabled={busy}
          className="btn-touch w-full !min-h-[140px] !text-2xl bg-red-600 hover:bg-red-700 text-white flex flex-col items-center justify-center gap-2 pulse-red disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-10 h-10 animate-spin" /> : <Ambulance className="w-12 h-12" />}
          {t(lang, 'callAmbulance')}
        </button>
        <a href="tel:108" className="btn-touch w-full bg-red-900 text-white flex items-center justify-center gap-2">
          <Phone className="w-5 h-5" /> {t(lang, 'call108')}
        </a>

        <div className="card p-4 space-y-3">
          <h3 className="font-bold text-emerald-900">{t(lang, 'familyIntro')}</h3>
          {QUESTIONS.map((q, i) => (
            <div key={i} className="space-y-1">
              <p className="text-sm text-emerald-900">{q}</p>
              <div className="grid grid-cols-2 gap-2">
                {[true, false].map((v) => (
                  <button
                    key={String(v)}
                    onClick={() => setAnswers((a) => ({ ...a, [i]: v }))}
                    className={`btn-touch !min-h-[48px] border-2 ${
                      answers[i] === v ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-emerald-900 border-emerald-200'
                    }`}
                  >
                    {v ? t(lang, 'yes') : t(lang, 'no')}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder={t(lang, 'freeText')}
            rows={2}
            className="w-full border-2 border-emerald-200 rounded-xl px-3 py-2 focus:border-emerald-500 outline-none"
          />
          <button
            onClick={() => send(true)}
            disabled={busy}
            className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-5 h-5 animate-spin" />} {t(lang, 'sendRequest')}
          </button>
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  // ---- SENT: live status ----
  const deadline = status?.deadline_at ? new Date(status.deadline_at).getTime() : 0;
  const secondsLeft = Math.max(0, (deadline - now) / 1000);
  const accepted = status?.status === 'ACCEPTED';

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
      <DemoBadge />
      <h2 className="text-xl font-bold text-red-800">{t(lang, 'emergencyRequestSent')}</h2>

      {accepted ? (
        <div className="card p-6 text-center border-2 border-emerald-500 bg-emerald-50">
          <Ambulance className="w-12 h-12 text-emerald-700 mx-auto mb-2" />
          <p className="text-lg font-bold text-emerald-900">{t(lang, 'acceptedBy')}</p>
          <p className="text-emerald-800">{status?.accepted_name}</p>
          {status?.accepted_address && <p className="text-sm text-emerald-700">{status.accepted_address}</p>}
        </div>
      ) : (
        <div className="card p-6 text-center border-2 border-red-300 bg-red-50 space-y-2">
          <p className="text-red-900 font-bold pulse-red">{t(lang, 'waitingAccept')}</p>
          <p className="text-red-800 text-sm">
            {t(lang, 'countdown')} {formatClock(secondsLeft)}{t(lang, 'seconds')} · {t(lang, 'keepRetrying')}
          </p>
          {status?.target_name && (
            <p className="text-sm text-red-800 flex items-center justify-center gap-1">
              <MapPin className="w-4 h-4" /> {status.target_name}
              {status.target_address ? ` — ${status.target_address}` : ''}
            </p>
          )}
          <button onClick={retry} className="btn-touch !min-h-[44px] bg-white border-2 border-red-300 text-red-800 inline-flex items-center gap-2 mx-auto">
            <RotateCcw className="w-4 h-4" /> {t(lang, 'keepRetrying')}
          </button>
        </div>
      )}

      {summary && (
        <div className="card p-4 space-y-1 text-sm">
          <p className="font-bold text-emerald-900">{summary.summary.chief_complaint}</p>
          <p className="text-emerald-800">{t(lang, 'severity')}: {summary.summary.severity}/10</p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="card p-4">
          <h3 className="font-bold text-emerald-900 mb-2">{t(lang, 'hospitalsNearby')}</h3>
          <ul className="space-y-1 text-sm">
            {candidates.map((c) => (
              <li key={c.id} className="flex justify-between text-emerald-800">
                <span>{c.name}</span>
                <span>{c.distance_km} {t(lang, 'kmAway')}{c.estimated ? ' ~' : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <a href="tel:108" className="btn-touch w-full bg-red-900 text-white flex items-center justify-center gap-2">
        <Phone className="w-5 h-5" /> {t(lang, 'noAcceptYet')}
      </a>
    </div>
  );
}
