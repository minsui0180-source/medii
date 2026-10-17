import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, Pencil, ArrowUpDown, ClipboardList } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode, QueueEntry, IntakeSummary, StaffRole, EmergencyRequest } from '@/types';
import { api, supabase } from '@/lib/supabase';
import { sortQueue } from '@/lib/helpers';
import { DemoBadge } from '@/components/Chrome';

export function TriageBadge({ level }: { level: string }) {
  const cls =
    level === 'EMERGENCY'
      ? 'bg-red-100 text-red-800 border-red-300'
      : level === 'URGENT'
        ? 'bg-amber-100 text-amber-900 border-amber-300'
        : 'bg-emerald-100 text-emerald-800 border-emerald-300';
  return <span className={`text-[10px] font-bold rounded-full border px-2 py-0.5 ${cls}`}>{level}</span>;
}

// ---------- DOCTOR ----------
export function DoctorView({ lang, queue }: { lang: LangCode; queue: QueueEntry[] }) {
  const sorted = sortQueue(queue);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QueueEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [editSummary, setEditSummary] = useState('');
  const [error, setError] = useState('');

  async function open(id: string) {
    setOpenId(id);
    setBusy(true);
    setError('');
    try {
      const { entry } = await api<{ entry: QueueEntry }>('staff/entry', { role: 'DOCTOR', id });
      setDetail(entry);
      setEditSummary(entry.summary ? JSON.stringify(entry.summary, null, 2) : '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, value?: unknown, extra?: Record<string, unknown>) {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      await api('staff/action', { role: 'DOCTOR', action, id: detail.id, value, ...extra });
      if (action === 'APPROVE') setDetail({ ...detail, status: 'SENT_TO_DOCTOR' });
      if (action === 'OVERRIDE') setDetail({ ...detail, triage_level: value as QueueEntry['triage_level'] });
      if (action === 'EDIT') setDetail({ ...detail, summary: JSON.parse(editSummary) as IntakeSummary });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="font-bold text-emerald-900 mb-3 flex items-center gap-2">
          <ClipboardList className="w-5 h-5" /> {t(lang, 'doctorQueue')}
        </h2>
        <ul className="space-y-2">
          {sorted.map((e) => (
            <li key={e.id}>
              <button
                onClick={() => open(e.id)}
                className={`w-full flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition ${
                  openId === e.id ? 'border-emerald-600 bg-emerald-50' : 'border-emerald-200 hover:border-emerald-400'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-bold text-emerald-900">{e.token}</span>
                  <span className="text-sm text-emerald-700">{e.patient_label}</span>
                </span>
                <span className="flex items-center gap-2">
                  {e.status === 'SENT_TO_DOCTOR' && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                  <TriageBadge level={e.triage_level} />
                </span>
              </button>
            </li>
          ))}
          {sorted.length === 0 && <p className="text-sm text-emerald-600">Queue is empty — add a patient from the home screen.</p>}
        </ul>
      </section>

      {openId && (
        <section className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-emerald-900">{detail?.token}</h3>
            <button onClick={() => { setOpenId(null); setDetail(null); }} className="text-sm text-emerald-700 underline">
              {t(lang, 'backToQueue')}
            </button>
          </div>
          {busy && !detail && <Loader2 className="w-5 h-5 animate-spin text-emerald-700" />}
          {detail && (
            <>
              <p className="text-sm">
                <span className="font-semibold text-emerald-900">{t(lang, 'patient')}:</span> {detail.patient_label}
                {detail.abha_id ? ` (${detail.abha_id})` : ''} <TriageBadge level={detail.triage_level} />
              </p>
              {detail.prior_history && (
                <div className="text-sm bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-emerald-900">{t(lang, 'priorRecords')}</span>
                    <span className="text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300 rounded-full px-2">DEMO DATA</span>
                  </div>
                  <p className="text-emerald-800">{t(lang, 'conditions')}: {detail.prior_history.conditions.join(', ')}</p>
                  <p className="text-emerald-800">{t(lang, 'medicines')}: {detail.prior_history.medicines.join(', ')}</p>
                  <p className="text-emerald-800">{t(lang, 'pastVisits')}: {detail.prior_history.past_visits.join(' · ')}</p>
                </div>
              )}
              <div className="text-sm">
                <span className="font-semibold text-emerald-900">{t(lang, 'aiSuggestion')}</span>
                {detail.summary && (
                  <div className="mt-1 space-y-1 text-emerald-800">
                    <p>{t(lang, 'chiefComplaint')}: {detail.summary.chief_complaint}</p>
                    <p>{t(lang, 'duration')}: {detail.summary.duration} — {t(lang, 'severity')} {detail.summary.severity}/10</p>
                  </div>
                )}
              </div>
              {detail.source_tags?.length > 0 && (
                <div className="text-xs space-y-1">
                  <span className="font-semibold text-emerald-900">{t(lang, 'sourceTags')}:</span>
                  {detail.source_tags.map((tag, i) => (
                    <p key={i} className="text-emerald-700">
                      <span className="inline-block bg-emerald-100 rounded px-1.5 mr-1 font-medium">{tag.source}</span>
                      {tag.claim}
                    </p>
                  ))}
                </div>
              )}
              {detail.ocr_records?.length > 0 && (
                <div className="text-xs space-y-1">
                  <span className="font-semibold text-emerald-900">{t(lang, 'ocrPrescriptions')}:</span>
                  {detail.ocr_records.flatMap((r) =>
                    r.medicines.map((m, i) => (
                      <p key={`${r.file}-${i}`} className="text-emerald-700">
                        {m.name} — {m.dosage} ({m.ocr_confidence}% {t(lang, 'ocrConfidence')}{m.needs_review ? `, ${t(lang, 'needsReview')}` : ''})
                      </p>
                    )),
                  )}
                </div>
              )}
              <textarea
                value={editSummary}
                onChange={(ev) => setEditSummary(ev.target.value)}
                rows={4}
                className="w-full border-2 border-emerald-200 rounded-xl px-3 py-2 text-xs font-mono focus:border-emerald-500 outline-none"
              />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <button onClick={() => act('APPROVE')} disabled={busy} className="btn-touch !min-h-[48px] bg-emerald-700 text-white disabled:opacity-50">
                  {t(lang, 'approve')}
                </button>
                <button onClick={() => act('EDIT')} disabled={busy} className="btn-touch !min-h-[48px] bg-white border-2 border-emerald-300 text-emerald-800 flex items-center justify-center gap-1 disabled:opacity-50">
                  <Pencil className="w-4 h-4" /> {t(lang, 'edit')}
                </button>
                {(['EMERGENCY', 'URGENT', 'ROUTINE'] as const).map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => act('OVERRIDE', lvl)}
                    disabled={busy || detail.triage_level === lvl}
                    className="btn-touch !min-h-[48px] !text-sm bg-amber-50 border-2 border-amber-300 text-amber-900 disabled:opacity-40"
                  >
                    {t(lang, 'overrideTo')} {lvl}
                  </button>
                ))}
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-700">{error}</p>}
        </section>
      )}

      <AuditLog lang={lang} />
    </div>
  );
}

// ---------- RECEPTION ----------
export function ReceptionView({ lang, queue }: { lang: LangCode; queue: QueueEntry[] }) {
  const sorted = sortQueue(queue);
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const ids = order.length === sorted.length ? order : sorted.map((e) => e.id);
  const byId = new Map(sorted.map((e) => [e.id, e]));

  function move(id: string, dir: -1 | 1) {
    const arr = [...ids];
    const i = arr.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setOrder(arr);
    setSaved(false);
  }

  async function saveOrder() {
    setBusy(true);
    try {
      await api('staff/action', { role: 'RECEPTION', action: 'REORDER', order: ids });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="font-bold text-emerald-900 mb-3 flex items-center gap-2">
          <ArrowUpDown className="w-5 h-5" /> {t(lang, 'receptionQueue')}
        </h2>
        <ul className="space-y-2">
          {ids.map((id, i) => {
            const e = byId.get(id);
            if (!e) return null;
            return (
              <li key={id} className="flex items-center justify-between rounded-xl border border-emerald-200 px-3 py-2.5">
                <span className="flex items-center gap-3">
                  <span className="font-bold text-emerald-900 w-8">{i + 1}.</span>
                  <span className="font-semibold text-emerald-900">{e.token}</span>
                </span>
                <span className="flex gap-1">
                  <button onClick={() => move(id, -1)} className="btn-touch !min-h-[44px] !min-w-[44px] px-2 bg-emerald-50 border border-emerald-300 text-emerald-800">↑</button>
                  <button onClick={() => move(id, 1)} className="btn-touch !min-h-[44px] !min-w-[44px] px-2 bg-emerald-50 border border-emerald-300 text-emerald-800">↓</button>
                </span>
              </li>
            );
          })}
        </ul>
        <button onClick={saveOrder} disabled={busy} className="btn-touch w-full mt-3 bg-emerald-700 text-white disabled:opacity-50">
          {saved ? t(lang, 'queueUpdated') : t(lang, 'submit')}
        </button>
        <p className="text-xs text-emerald-600 mt-2">Every change is recorded in the audit log.</p>
      </section>
      <AuditLog lang={lang} />
    </div>
  );
}

// ---------- ADMIN ----------
export function AdminView({
  lang,
  hospitals,
  requests,
}: {
  lang: LangCode;
  hospitals: { id: string; name: string; icu_beds_available: number; ventilators_available: number; specialists_on_duty: string[]; blood_stock: Record<string, number> }[];
  requests: EmergencyRequest[];
}) {
  const [declineFor, setDeclineFor] = useState<{ requestId: string; hospitalId: string; hospitalName: string } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const hospital = hospitals[1] ?? hospitals[0]; // demo admin manages one hospital

  async function toggle(field: 'icu_beds_available' | 'ventilators_available', delta: number) {
    if (!hospital) return;
    const next = Math.max(0, hospital[field] + delta);
    const { error } = await supabase.from('hospitals').update({ [field]: next }).eq('id', hospital.id);
    if (error) console.error(error);
  }

  async function respond(requestId: string, hospitalId: string, hospitalName: string, action: 'ACCEPT' | 'DECLINE', declineReason?: string) {
    setBusy(true);
    try {
      await api('emergency/respond', { role: 'ADMIN', request_id: requestId, hospital_id: hospitalId, hospital_name: hospitalName, action, reason: declineReason });
    } finally {
      setBusy(false);
      setDeclineFor(null);
      setReason('');
    }
  }

  const active = requests.filter((r) => r.status === 'BROADCASTING');

  return (
    <div className="space-y-4">
      <section className="card p-4 space-y-3">
        <h2 className="font-bold text-emerald-900">{t(lang, 'adminCapacity')}</h2>
        {hospital ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-emerald-900 font-medium">{hospital.name}</span>
              <DemoBadge />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-emerald-200 px-3 py-2">
              <span className="text-emerald-800">{t(lang, 'icuBeds')}</span>
              <span className="flex items-center gap-2">
                <button onClick={() => toggle('icu_beds_available', -1)} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">−</button>
                <span className="font-bold text-lg text-emerald-900 w-8 text-center">{hospital.icu_beds_available}</span>
                <button onClick={() => toggle('icu_beds_available', 1)} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">+</button>
              </span>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-emerald-200 px-3 py-2">
              <span className="text-emerald-800">{t(lang, 'ventilators')}</span>
              <span className="flex items-center gap-2">
                <button onClick={() => toggle('ventilators_available', -1)} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">−</button>
                <span className="font-bold text-lg text-emerald-900 w-8 text-center">{hospital.ventilators_available}</span>
                <button onClick={() => toggle('ventilators_available', 1)} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">+</button>
              </span>
            </div>
            <p className="text-emerald-800">{t(lang, 'specialists')}: {hospital.specialists_on_duty.join(', ') || '—'}</p>
            <p className="text-emerald-800">
              {t(lang, 'bloodStock')}:{' '}
              {Object.entries(hospital.blood_stock).map(([bg, units]) => `${bg}: ${units}`).join(' · ')}
            </p>
          </div>
        ) : (
          <p className="text-sm text-emerald-600">Loading…</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-bold text-emerald-900">{t(lang, 'incomingRequests')}</h2>
        {active.length === 0 && <p className="text-sm text-emerald-600">No active emergency requests.</p>}
        {active.map((r) => (
          <div key={r.id} className="card p-4 space-y-2 border-2 border-red-300 bg-red-50">
            <p className="font-bold text-red-900">{r.patient_label}</p>
            {r.emergency_summary && (
              <p className="text-sm text-red-800">
                {r.emergency_summary.summary?.chief_complaint} — {t(lang, 'severity')} {r.emergency_summary.summary?.severity}/10
              </p>
            )}
            {r.lat != null && <p className="text-xs text-red-700">GPS: {r.lat.toFixed(5)}, {r.lng?.toFixed(5)}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => hospital && respond(r.id, hospital.id, hospital.name, 'ACCEPT')}
                disabled={busy || !hospital}
                className="btn-touch !min-h-[52px] bg-emerald-600 text-white disabled:opacity-50"
              >
                {t(lang, 'accept')}
              </button>
              <button
                onClick={() => hospital && setDeclineFor({ requestId: r.id, hospitalId: hospital.id, hospitalName: hospital.name })}
                disabled={busy || !hospital}
                className="btn-touch !min-h-[52px] bg-red-600 text-white disabled:opacity-50"
              >
                {t(lang, 'decline')}
              </button>
            </div>
            {declineFor?.requestId === r.id && (
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-2">
                  {[t(lang, 'reasonNoIcu'), t(lang, 'reasonNoSpecialist'), t(lang, 'reasonNoBlood'), t(lang, 'reasonOther')].map((rc) => (
                    <button
                      key={rc}
                      onClick={() => respond(r.id, declineFor.hospitalId, declineFor.hospitalName, 'DECLINE', rc)}
                      className="btn-touch !min-h-[48px] !text-sm bg-white border-2 border-red-300 text-red-800"
                    >
                      {rc}
                    </button>
                  ))}
                </div>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t(lang, 'declineReasonPlaceholder')}
                  className="w-full border-2 border-red-200 rounded-xl px-3 min-h-[48px] focus:border-red-400 outline-none"
                />
                <button
                  onClick={() => reason.trim() && respond(r.id, declineFor.hospitalId, declineFor.hospitalName, 'DECLINE', reason.trim())}
                  className="btn-touch w-full bg-red-700 text-white"
                >
                  {t(lang, 'respond')}
                </button>
              </div>
            )}
          </div>
        ))}
      </section>
      <AuditLog lang={lang} />
    </div>
  );
}

// ---------- shared audit log ----------
export function AuditLog({ lang }: { lang: LangCode }) {
  const [log, setLog] = useState<{ id: string; ts: string; role: string; action: string; patient_ref: string }[]>([]);
  useEffect(() => {
    api<{ log: typeof log }>('audit/list', {}).then((d) => setLog(d.log ?? [])).catch(() => undefined);
  }, []);
  return (
    <section className="card p-4">
      <h2 className="font-bold text-emerald-900 mb-2">{t(lang, 'auditLog')}</h2>
      <ul className="text-xs space-y-1 max-h-56 overflow-y-auto">
        {log.map((l) => (
          <li key={l.id} className="text-emerald-700 border-b border-emerald-50 pb-1">
            {new Date(l.ts).toLocaleTimeString()} — <span className="font-semibold">{l.role}</span> {l.action} {l.patient_ref}
          </li>
        ))}
        {log.length === 0 && <li className="text-emerald-500">No entries yet.</li>}
      </ul>
    </section>
  );
}
