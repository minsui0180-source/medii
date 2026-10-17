import { useRef, useState } from 'react';
import { Mic, MicOff, Loader2, Keyboard, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { intake, type IntakeResult, type OcrRecord } from '@/lib/api';
import type { LangCode, PatientRecord } from '@/types';
import { t } from '@/lib/i18n';
import { createRecognition, speak } from '@/lib/helpers';
import { DemoBadge } from '@/components/Chrome';
import { OcrUploader } from '@/components/OcrUploader';

const MAX_FOLLOWUPS = 3;

export function IntakeSummaryCard({ intake, lang }: { intake: IntakeResult; lang: LangCode }) {
  const levelColor =
    intake.triage_level === 'EMERGENCY' ? 'bg-red-100 text-red-900 border-red-300'
    : intake.triage_level === 'URGENT' ? 'bg-amber-100 text-amber-900 border-amber-300'
    : 'bg-emerald-100 text-emerald-900 border-emerald-300';
  return (
    <div className="card p-4 space-y-2 fade-in">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold text-emerald-900">{t(lang, 'aiSuggestion')}</h3>
        <span className={`text-xs font-bold rounded-full px-2 py-1 border ${levelColor}`}>{intake.triage_level}</span>
      </div>
      <p className="text-emerald-900">
        <span className="font-semibold">{t(lang, 'chiefComplaint')}:</span> {intake.summary.chief_complaint}
      </p>
      <p className="text-sm text-emerald-800">{t(lang, 'duration')}: {intake.summary.duration} · {t(lang, 'severity')}: {intake.summary.severity}/10</p>
      {intake.summary.relevant_history.length > 0 && (
        <p className="text-sm text-emerald-800">{t(lang, 'relevantHistory')}: {intake.summary.relevant_history.join(', ')}</p>
      )}
      {intake.source_tags.length > 0 && (
        <p className="text-xs text-emerald-700">
          {t(lang, 'sourceTags')}: {intake.source_tags.map((s) => `${s.claim} (${s.source})`).join(' · ')}
        </p>
      )}
      {intake.mock && (
        <p className="text-xs text-amber-800 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {t(lang, 'aiMockNote')}</p>
      )}
    </div>
  );
}

export function VoiceIntake({
  lang,
  triageFloor,
  prior,
  onEscalate,
  onDone,
}: {
  lang: LangCode;
  triageFloor: 'ROUTINE' | 'URGENT';
  prior: PatientRecord | null;
  onEscalate: (reason: string) => void;
  onDone: (r: { intake: IntakeResult; transcript: string; answers: { question: string; answer: string }[]; ocr: OcrRecord[] }) => void;
}) {
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceError, setVoiceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [intakeResult, setIntakeResult] = useState<IntakeResult | null>(null);
  const [followupAnswer, setFollowupAnswer] = useState('');
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [ocr, setOcr] = useState<OcrRecord[]>([]);
  const recRef = useRef<ReturnType<typeof createRecognition>>(null);
  const wantListeningRef = useRef(false);

  function stopMic() {
    wantListeningRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
    setInterim('');
  }

  function startMic() {
    const rec = createRecognition(lang);
    if (!rec) {
      setVoiceSupported(false);
      return;
    }
    recRef.current = rec;
    rec.onresult = (e) => {
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i][0];
        if (r.isFinal || e.results[i][0].isFinal) finalText += r.transcript;
        else interimText += r.transcript;
      }
      if (finalText) setTranscript((prev) => (prev ? `${prev} ${finalText}` : finalText));
      setInterim(interimText);
    };
    rec.onerror = (e) => {
      // "no-speech" just means silence — keep listening. "not-allowed" means mic blocked.
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        setVoiceError(t(lang, 'micBlocked'));
        wantListeningRef.current = false;
        setListening(false);
      } else if (e?.error === 'audio-capture') {
        setVoiceError(t(lang, 'micNotFound'));
        wantListeningRef.current = false;
        setListening(false);
      }
    };
    rec.onend = () => {
      // Browsers cut recognition after a pause; restart while the user still wants to listen.
      if (wantListeningRef.current) {
        try {
          rec.start();
          return;
        } catch {
          /* already started — fall through */
        }
      }
      setListening(false);
      setInterim('');
    };
    try {
      rec.start();
      wantListeningRef.current = true;
      setListening(true);
      setVoiceError('');
    } catch {
      setVoiceError(t(lang, 'micStartFailed'));
    }
  }

  function toggleMic() {
    if (listening) {
      stopMic();
      return;
    }
    startMic();
  }

  async function analyze() {
    if (!transcript.trim() && answers.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await intake({
        language: lang,
        transcript: transcript.trim(),
        triage_floor: triageFloor,
        prior_history: prior ?? undefined,
        followup_answers: answers.length ? answers : undefined,
      });
      if (result.triage_level === 'EMERGENCY') {
        onEscalate(result.emergency_reason ?? '');
        return;
      }
      setIntakeResult(result);
      if (result.followup_question) speak(result.followup_question, lang);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswer() {
    if (!intakeResult?.followup_question || !followupAnswer.trim()) return;
    const next = [...answers, { question: intakeResult.followup_question, answer: followupAnswer.trim() }];
    setAnswers(next);
    setFollowupAnswer('');
    setBusy(true);
    try {
      const result = await intake({
        language: lang,
        transcript: transcript.trim(),
        triage_floor: triageFloor,
        prior_history: prior ?? undefined,
        followup_answers: next,
      });
      if (result.triage_level === 'EMERGENCY') {
        onEscalate(result.emergency_reason ?? '');
        return;
      }
      setIntakeResult(result);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = intakeResult && (!intakeResult.followup_question || answers.length >= MAX_FOLLOWUPS);

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
      <DemoBadge />
      <h2 className="text-xl font-bold text-emerald-900">{t(lang, 'intakeTitle')}</h2>
      <p className="text-sm text-emerald-700">{t(lang, 'intakeHint')}</p>

      {voiceSupported ? (
        <>
          <button
            onClick={toggleMic}
            className={`btn-touch w-full !min-h-[72px] !text-lg flex items-center justify-center gap-3 ${
              listening ? 'bg-red-600 text-white pulse-red' : 'bg-emerald-700 hover:bg-emerald-800 text-white'
            }`}
          >
            {listening ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
            {listening ? t(lang, 'micStop') : t(lang, 'micStart')}
          </button>
          {interim && (
            <p className="text-sm text-emerald-600 italic px-1">{interim}…</p>
          )}
          {voiceError && (
            <p className="text-sm text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {voiceError}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {t(lang, 'voiceUnavailable')}
        </p>
      )}

      <div className="relative">
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder={t(lang, 'typeHere')}
          rows={3}
          className="w-full border-2 border-emerald-200 rounded-xl px-3 py-2 text-base focus:border-emerald-500 outline-none"
        />
        <Keyboard className="w-4 h-4 text-emerald-400 absolute right-3 top-3" />
      </div>

      <button
        onClick={analyze}
        disabled={busy || (!transcript.trim() && answers.length === 0)}
        className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy && <Loader2 className="w-5 h-5 animate-spin" />} {t(lang, 'submit')}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}

      {intakeResult && <IntakeSummaryCard intake={intakeResult} lang={lang} />}

      {intakeResult?.followup_question && answers.length < MAX_FOLLOWUPS && (
        <div className="card p-4 space-y-2 border-2 border-amber-200 bg-amber-50">
          <p className="font-medium text-amber-900">{intakeResult.followup_question}</p>
          <input
            value={followupAnswer}
            onChange={(e) => setFollowupAnswer(e.target.value)}
            placeholder={t(lang, 'answer')}
            className="w-full border-2 border-amber-200 rounded-xl px-3 min-h-[52px] focus:border-amber-400 outline-none"
          />
          <button onClick={submitAnswer} disabled={busy || !followupAnswer.trim()} className="btn-touch w-full bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50">
            {t(lang, 'nextQuestion')}
          </button>
        </div>
      )}

      {answers.length > 0 && (
        <ul className="text-sm space-y-1">
          {answers.map((a, i) => (
            <li key={i} className="text-emerald-800 flex gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
              <span><span className="font-medium">{a.question}</span> — {a.answer}</span>
            </li>
          ))}
        </ul>
      )}

      <OcrUploader lang={lang} onSaved={(rec) => setOcr((o) => [...o, rec])} />

      {canSubmit && (
        <button
          onClick={() => onDone({ intake: intakeResult, transcript: transcript.trim(), answers, ocr })}
          className="btn-touch w-full !min-h-[60px] !text-lg bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          {t(lang, 'preArrival')} →
        </button>
      )}
    </div>
  );
}
