import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, Loader2, Keyboard, AlertTriangle, Phone, ArrowRight, CheckCircle2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode, IntakeResult, OcrRecord, Patient, SourceTag } from '@/types';
import { api } from '@/lib/supabase';
import { createRecognition, speak } from '@/lib/helpers';
import { DemoBadge } from '@/components/Chrome';
import { OcrUploader } from '@/components/OcrUploader';

interface PriorHistory {
  conditions: string[];
  medicines: string[];
  past_visits: string[];
  ocr_prescriptions: OcrRecord[];
}

interface Props {
  lang: LangCode;
  patient: { name: string; abhaId: string | null; prior: PriorHistory | null };
  onEscalate: (reason: string) => void;
  onDone: (result: { intake: IntakeResult; transcript: string; answers: { question: string; answer: string }[]; ocr: OcrRecord[] }) => void;
}

const MAX_TURNS = 4;

export function VoiceIntake({ lang, patient, onEscalate, onDone }: Props) {
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [typed, setTyped] = useState('');
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [intake, setIntake] = useState<IntakeResult | null>(null);
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [turns, setTurns] = useState(0);
  const [error, setError] = useState('');
  const [ocrRecords, setOcrRecords] = useState<OcrRecord[]>([]);
  const recRef = useRef<ReturnType<typeof createRecognition>>(null);

  useEffect(() => {
    return () => {
      recRef.current?.stop();
    };
  }, []);

  function toggleMic() {
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = createRecognition(lang);
    if (!rec) {
      setVoiceSupported(false);
      return;
    }
    recRef.current = rec;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res[0].transcript) {
          if (i < e.results.length && (res as unknown as { isFinal?: boolean }).isFinal) finalText += res[0].transcript + ' ';
          else interim += res[0].transcript;
        }
      }
      setTranscript((patient.name ? '' : '') + (finalText + interim).trim());
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
    setListening(true);
  }

  async function submit(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api<IntakeResult>('intake', {
        language: lang,
        transcript: text,
        prior_history: patient.prior,
      });
      if (data.triage_level === 'EMERGENCY' && data.emergency_reason) {
        onEscalate(data.emergency_reason);
        return;
      }
      setIntake(data);
      setTranscript(text);
      speak(data.summary?.chief_complaint ?? '', lang);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function answerFollowup(value: string) {
    if (!intake || busy) return;
    const q = intake.followup_questions[answers.length];
    const next = [...answers, { question: q, answer: value }];
    setAnswers(next);
    setCurrentAnswer('');
    const newText = `${transcript} ${q} ${value}`.trim();
    setTranscript(newText);
    const nextTurn = turns + 1;
    setTurns(nextTurn);
    const remaining = intake.followup_questions.length - next.length;
    if (remaining <= 0 || nextTurn >= MAX_TURNS) {
      onDone({ intake, transcript: newText, answers: next, ocr: ocrRecords });
      return;
    }
    setBusy(true);
    try {
      const data = await api<IntakeResult>('followup', {
        language: lang,
        transcript: newText,
        prior_history: patient.prior,
      });
      if (data.triage_level === 'EMERGENCY' && data.emergency_reason) {
        onEscalate(data.emergency_reason);
        return;
      }
      setIntake({ ...data, followup_questions: data.followup_questions.slice(0, Math.max(0, remaining - 1 > 0 ? remaining : 0)) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const currentQuestion = intake?.followup_questions[answers.length];

  if (intake && currentQuestion) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
        <div className="card p-5 space-y-4">
          <h2 className="text-lg font-bold text-emerald-900">{t(lang, 'followupTitle')}</h2>
          <p className="text-xl font-medium text-emerald-900">{currentQuestion}</p>
          <div className="grid grid-cols-2 gap-3">
            {['Yes', 'No'].map((c) => (
              <button
                key={c}
                onClick={() => answerFollowup(c)}
                className={`btn-touch ${c === 'Yes' ? 'bg-emerald-600 text-white' : 'bg-red-500 text-white'}`}
              >
                {c === 'Yes' ? t(lang, 'yes') : t(lang, 'no')}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={currentAnswer}
              onChange={(e) => setCurrentAnswer(e.target.value)}
              placeholder={t(lang, 'answer')}
              className="flex-1 border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
            />
            <button
              onClick={() => answerFollowup(currentAnswer)}
              disabled={!currentAnswer.trim() || busy}
              className="btn-touch bg-emerald-700 text-white px-5 flex items-center disabled:opacity-40"
            >
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </div>
        {busy && (
          <p className="flex items-center gap-2 text-emerald-700">
            <Loader2 className="w-4 h-4 animate-spin" /> {t(lang, 'loading')}
          </p>
        )}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  if (intake && !currentQuestion) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
        <IntakeSummaryCard lang={lang} intake={intake} prior={patient.prior} />
        <button
          onClick={() => onDone({ intake, transcript, answers, ocr: ocrRecords })}
          className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white"
        >
          {t(lang, 'continue')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
      <h2 className="text-xl font-bold text-emerald-900">{t(lang, 'intakeTitle')}</h2>
      <p className="text-emerald-700">{t(lang, 'intakeHint')}</p>

      {patient.prior && (
        <div className="card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-emerald-900">{t(lang, 'priorRecords')}</h3>
            <DemoBadge />
          </div>
          <p className="text-sm"><span className="font-semibold text-emerald-900">{patient.name}</span></p>
          <div className="grid sm:grid-cols-2 gap-2 text-sm text-emerald-800">
            <p><span className="font-semibold">{t(lang, 'conditions')}:</span> {patient.prior.conditions.join(', ') || '—'}</p>
            <p><span className="font-semibold">{t(lang, 'medicines')}:</span> {patient.prior.medicines.join(', ') || '—'}</p>
          </div>
          {patient.prior.ocr_prescriptions.length > 0 && (
            <div className="text-xs text-emerald-700 border-t border-emerald-100 pt-2">
              <span className="font-semibold">{t(lang, 'ocrPrescriptions')}:</span>{' '}
              {patient.prior.ocr_prescriptions[0].medicines.map((m) => `${m.name} (${m.ocr_confidence}%)`).join(', ')}
            </div>
          )}
        </div>
      )}

      <button
        onClick={toggleMic}
        className={`btn-touch !min-h-[112px] w-full flex flex-col items-center justify-center gap-2 ${
          listening ? 'bg-red-600 text-white pulse-red' : 'bg-emerald-700 hover:bg-emerald-800 text-white'
        }`}
      >
        {listening ? <MicOff className="w-9 h-9" /> : <Mic className="w-9 h-9" />}
        <span className="text-lg">{listening ? t(lang, 'micStop') : t(lang, 'micStart')}</span>
      </button>
      {!voiceSupported && <p className="text-sm text-amber-800 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> {t(lang, 'voiceUnavailable')}</p>}

      {transcript && (
        <div className="card p-3 text-emerald-900 bg-emerald-50 border-emerald-200 text-sm">
          <span className="font-semibold">{t(lang, 'speakNow')}:</span> {transcript}
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1 flex items-center gap-2 border-2 border-emerald-200 rounded-xl px-3 min-h-[52px]">
          <Keyboard className="w-5 h-5 text-emerald-600 shrink-0" />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t(lang, 'typeHere')}
            className="flex-1 outline-none text-lg bg-transparent"
          />
        </div>
        <button
          onClick={() => submit(typed || transcript)}
          disabled={(!typed.trim() && !transcript.trim()) || busy}
          className="btn-touch bg-emerald-700 hover:bg-emerald-800 text-white px-6 disabled:opacity-40 flex items-center gap-2"
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          {t(lang, 'submit')}
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}

      <OcrUploader lang={lang} onSaved={(rec) => setOcrRecords((r) => [...r, rec])} />
    </div>
  );
}

export function IntakeSummaryCard({
  lang,
  intake,
  prior,
}: {
  lang: LangCode;
  intake: IntakeResult;
  prior: PriorHistory | null;
}) {
  const tags: SourceTag[] = intake.source_tags ?? [];
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold tracking-wide bg-sky-100 text-sky-900 border border-sky-300 rounded-full px-2 py-0.5 uppercase">
          {t(lang, 'aiSuggestion')}
        </span>
        {intake.mock && <DemoBadge />}
      </div>
      <div className="grid sm:grid-cols-2 gap-2 text-sm">
        <p><span className="font-semibold text-emerald-900">{t(lang, 'chiefComplaint')}:</span> {intake.summary?.chief_complaint}</p>
        <p><span className="font-semibold text-emerald-900">{t(lang, 'duration')}:</span> {intake.summary?.duration}</p>
        <p><span className="font-semibold text-emerald-900">{t(lang, 'severity')}:</span> {intake.summary?.severity}/10</p>
      </div>
      {prior && (
        <p className="text-sm text-emerald-800">
          <span className="font-semibold">{t(lang, 'relevantHistory')}:</span>{' '}
          {[...prior.conditions, ...(intake.summary?.relevant_history ?? [])].join(' · ')}
        </p>
      )}
      {tags.length > 0 && (
        <div className="text-xs space-y-1 border-t border-emerald-100 pt-2">
          <span className="font-semibold text-emerald-900">{t(lang, 'sourceTags')}:</span>
          {tags.map((tag, i) => (
            <p key={i} className="text-emerald-700">
              <span className="inline-block bg-emerald-100 rounded px-1.5 mr-1 font-medium">{tag.source}</span>
              {tag.claim}
            </p>
          ))}
        </div>
      )}
      <p className="text-[11px] text-emerald-600 flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" /> Not a diagnosis — for clinician review only.
      </p>
    </div>
  );
}
