import { useEffect, useMemo, useState } from 'react';
import { Ticket, Clock, ListOrdered, CheckCircle2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode, QueueEntry, IntakeResult, OcrRecord } from '@/types';
import { sortQueue, estimateWaitMinutes } from '@/lib/helpers';
import { useQueueLive } from '@/lib/live';
import { IntakeSummaryCard } from '@/screens/VoiceIntake';

interface Props {
  lang: LangCode;
  token: string;
  hospitalName: string;
  entryId: string;
  intake: IntakeResult;
  ocr: OcrRecord[];
  onStaffLogin: () => void;
}

export function QueueStatus({ lang, token, hospitalName, entryId, intake, ocr, onStaffLogin }: Props) {
  const { queue, loaded } = useQueueLive();

  const sorted = useMemo(() => sortQueue(queue), [queue]);
  const mine = sorted.findIndex((e: QueueEntry) => e.id === entryId);
  const position = mine >= 0 ? mine + 1 : sorted.length + 1;
  const total = sorted.length;
  const wait = estimateWaitMinutes(position);
  const ahead = sorted.slice(0, Math.max(0, mine));

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
      <div className="card p-5 bg-emerald-50 border-emerald-200 space-y-3">
        <h2 className="text-xl font-bold text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-6 h-6" /> {t(lang, 'appointmentTitle')}
        </h2>
        <p className="text-emerald-800 font-medium">{hospitalName}</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl border border-emerald-200 p-3 text-center">
            <Ticket className="w-5 h-5 mx-auto text-emerald-700" />
            <p className="text-[11px] text-emerald-700 mt-1">{t(lang, 'yourToken')}</p>
            <p className="font-bold text-lg text-emerald-900">{token}</p>
          </div>
          <div className="bg-white rounded-xl border border-emerald-200 p-3 text-center">
            <ListOrdered className="w-5 h-5 mx-auto text-emerald-700" />
            <p className="text-[11px] text-emerald-700 mt-1">{t(lang, 'position')}</p>
            <p className="font-bold text-lg text-emerald-900">
              {position} {t(lang, 'positionOf')} {total}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-emerald-200 p-3 text-center">
            <Clock className="w-5 h-5 mx-auto text-emerald-700" />
            <p className="text-[11px] text-emerald-700 mt-1">{t(lang, 'estimatedWait')}</p>
            <p className="font-bold text-lg text-emerald-900">
              ~{wait} {t(lang, 'minutes')}
            </p>
          </div>
        </div>
        <p className="text-xs text-emerald-700">Updates live — keep this screen open.</p>
      </div>

      <IntakeSummaryCard lang={lang} intake={intake} prior={null} />

      {ocr.length > 0 && (
        <div className="card p-4 text-sm space-y-1">
          <p className="font-semibold text-emerald-900">{t(lang, 'ocrPrescriptions')}</p>
          {ocr.map((r, i) => (
            <p key={i} className="text-emerald-700">
              {r.medicines.map((m) => `${m.name} — ${m.dosage} (${m.ocr_confidence}%)`).join('; ')}
            </p>
          ))}
        </div>
      )}

      {loaded && (
        <div className="card p-4">
          <p className="font-semibold text-emerald-900 mb-2">{t(lang, 'doctorQueue')}</p>
          <ul className="space-y-1 text-sm">
            {sorted.map((e: QueueEntry, i: number) => (
              <li
                key={e.id}
                className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${
                  e.id === entryId ? 'bg-emerald-100 font-bold text-emerald-900' : 'text-emerald-800'
                }`}
              >
                <span>
                  {i + 1}. {e.token}
                </span>
                <span
                  className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${
                    e.triage_level === 'EMERGENCY'
                      ? 'bg-red-100 text-red-800'
                      : e.triage_level === 'URGENT'
                        ? 'bg-amber-100 text-amber-900'
                        : 'bg-emerald-100 text-emerald-800'
                  }`}
                >
                  {e.triage_level}
                </span>
              </li>
            ))}
          </ul>
          {ahead.length === 0 && <p className="text-xs text-emerald-600 mt-2">You are next.</p>}
        </div>
      )}

      <button onClick={onStaffLogin} className="w-full text-sm text-emerald-800 underline py-2">
        {t(lang, 'doctorLogin')}
      </button>
    </div>
  );
}
