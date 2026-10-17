import { useCallback, useEffect, useState } from 'react';
import { Loader2, ArrowUp, ArrowDown, Stethoscope, ClipboardList, Activity, Package, Timer, AlertTriangle } from 'lucide-react';
import {
  staffQueue,
  staffEntry,
  staffApprove,
  staffOverride,
  staffReorder,
  staffOcr,
  staffCapacity,
  staffAudit,
  staffAdminOverview,
  emergencyRespond,
  asvPlan,
  asvRequest,
  asvStatus,
  asvStock,
  asvRespond,
  asvDispatch,
  asvReceive,
  type QueueRow,
  type AsvStatusResult,
  type AdminOverview,
} from '@/lib/api';
import type { LangCode } from '@/types';
import { t } from '@/lib/i18n';
import { useRefreshSignal, usePollFallback } from '@/lib/refresh';
import { compressImage } from '@/lib/helpers';

function useStaffQueue() {
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const { queue: q } = await staffQueue();
      setQueue(q ?? []);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRefreshSignal(refresh, 'queue');
  usePollFallback(refresh);
  return { queue, error, refresh };
}

const LEVEL_STYLE: Record<string, string> = {
  ROUTINE: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  URGENT: 'bg-amber-100 text-amber-900 border-amber-300',
  EMERGENCY: 'bg-red-100 text-red-900 border-red-300',
};

// ---------- DOCTOR ----------
export function DoctorView({ lang }: { lang: LangCode }) {
  const { queue, error } = useStaffQueue();
  const [openId, setOpenId] = useState<string | null>(null);
  const [entry, setEntry] = useState<QueueRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'QUEUE' | 'ASV'>('QUEUE');

  async function open(id: string) {
    setOpenId(id);
    setBusy(true);
    try {
      const { entry: e } = await staffEntry(id);
      setEntry(e ?? null);
    } finally {
      setBusy(false);
    }
  }

  if (openId) {
    return (
      <EntryDetail
        lang={lang}
        entry={entry}
        busy={busy}
        onBack={() => setOpenId(null)}
        onApprove={async () => {
          if (!entry?.summary) return;
          setBusy(true);
          try {
            await staffApprove(entry.id!, entry.summary);
            setOpenId(null);
          } finally {
            setBusy(false);
          }
        }}
        onOverride={async (level) => {
          setBusy(true);
          try {
            await staffOverride(entry!.id!, level);
            const { entry: e } = await staffEntry(entry!.id!);
            setEntry(e ?? null);
          } finally {
            setBusy(false);
          }
        }}
        onOcr={async (file) => {
          setBusy(true);
          try {
            const { base64, mime } = await compressImage(file);
            const { record } = await staffOcr(entry!.id!, base64, mime);
            setEntry((e) => (e ? { ...e, ocr_records: [...(e.ocr_records ?? []), record] } : e));
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          onClick={() => setView('QUEUE')}
          className={`btn-touch !min-h-[44px] flex-1 flex items-center justify-center gap-2 border-2 ${view === 'QUEUE' ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-emerald-900 border-emerald-200'}`}
        >
          <ClipboardList className="w-4 h-4" /> {t(lang, 'doctorQueue')}
        </button>
        <button
          onClick={() => setView('ASV')}
          className={`btn-touch !min-h-[44px] flex-1 flex items-center justify-center gap-2 border-2 ${view === 'ASV' ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-emerald-900 border-emerald-200'}`}
        >
          <Package className="w-4 h-4" /> ASV
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {view === 'QUEUE' ? (
        <>
          {queue.length === 0 && <p className="text-sm text-emerald-600">{t(lang, 'loading')}</p>}
          {queue.map((row) => (
            <button
              key={row.token}
              onClick={() => row.id && open(row.id)}
              className="card p-4 w-full text-left flex items-center gap-3 hover:border-emerald-400"
            >
              <span className="font-black text-lg text-emerald-900 w-24">{row.token}</span>
              <span className={`text-xs font-bold rounded-full px-2 py-1 border ${LEVEL_STYLE[row.triage_level ?? ''] ?? ''}`}>
                {row.triage_level}
              </span>
              <span className="text-sm text-emerald-800 truncate flex-1">
                {row.summary?.chief_complaint ?? row.patient_label}
              </span>
              <span className="text-xs text-emerald-600 uppercase">{row.status}</span>
            </button>
          ))}
        </>
      ) : (
        <DoctorAsv lang={lang} />
      )}
    </div>
  );
}

function DoctorAsv({ lang }: { lang: LangCode }) {
  const [vials, setVials] = useState('2');
  const [stable, setStable] = useState(false);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<{ transfer_request_id: string; plan: Awaited<ReturnType<typeof asvPlan>>['plan'] } | null>(null);
  const [status, setStatus] = useState<AsvStatusResult | null>(null);

  async function makePlan() {
    setBusy(true);
    setError('');
    try {
      // Demo: doctor's own location — server falls back to city coords when nulls.
      const result = await asvPlan({ origin_lat: 28.6139, origin_lng: 77.209, vials_needed: Number(vials) || 1, patient_stable: stable, patient_ref: ref.trim() || 'WALKIN' });
      setPlan(result);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function sendRequest() {
    if (!plan) return;
    setBusy(true);
    try {
      await asvRequest(plan.transfer_request_id);
      const s = await asvStatus(plan.transfer_request_id);
      setStatus(s);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-4 space-y-2">
        <h3 className="font-bold text-emerald-900 flex items-center gap-2"><Package className="w-5 h-5" /> ASV request</h3>
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Patient ref" className="w-full border-2 border-emerald-200 rounded-xl px-3 min-h-[48px]" />
        <input value={vials} onChange={(e) => setVials(e.target.value)} inputMode="numeric" placeholder="Vials needed" className="w-full border-2 border-emerald-200 rounded-xl px-3 min-h-[48px]" />
        <label className="flex items-center gap-2 text-sm text-emerald-900">
          <input type="checkbox" checked={stable} onChange={(e) => setStable(e.target.checked)} /> Patient stable enough to travel
        </label>
        <button onClick={makePlan} disabled={busy} className="btn-touch w-full bg-emerald-700 text-white disabled:opacity-50 flex items-center justify-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Plan
        </button>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      {plan && (
        <div className="card p-4 space-y-2 fade-in">
          <p className="font-bold text-emerald-900">{plan.plan.status}</p>
          <p className="text-sm text-emerald-800">{plan.plan.move_mode}: {plan.plan.move_reason}</p>
          {plan.plan.sources.map((s) => (
            <p key={s.batch_id} className="text-sm text-emerald-800">
              {s.hospital_name} — {s.vials} vial(s), batch {s.batch_code}, ~{s.travel_minutes} min {s.estimated ? '~' : ''}
              {s.toxicology_24x7 ? ' · 24x7 toxicology' : ''}
            </p>
          ))}
          {plan.plan.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {w}</p>
          ))}
          {plan.plan.status === 'PLAN_READY' && (
            <button onClick={sendRequest} disabled={busy} className="btn-touch w-full bg-emerald-600 text-white">
              Send request
            </button>
          )}
        </div>
      )}

      {status && (
        <div className="card p-4 space-y-1 text-sm fade-in">
          <p className="font-bold text-emerald-900">Transfer {status.request.status}</p>
          <p className="text-emerald-800">Current location: {status.current_location ?? '—'}</p>
          <p className="text-emerald-800">Transit: {status.transit_minutes ?? '—'} min · Cold chain: {status.cold_chain_ok === false ? 'WARNING' : 'OK'}</p>
          {status.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {w}</p>
          ))}
          <ul className="pt-1">
            {status.custody_events.slice(-5).map((e) => (
              <li key={e.id} className="text-emerald-700 border-t border-emerald-50 pt-1">
                {new Date(e.at).toLocaleTimeString()} — {e.event} @ {e.location_name} ({e.actor})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EntryDetail({
  lang,
  entry,
  busy,
  onBack,
  onApprove,
  onOverride,
  onOcr,
}: {
  lang: LangCode;
  entry: QueueRow | null;
  busy: boolean;
  onBack: () => void;
  onApprove: () => void;
  onOverride: (level: string) => void;
  onOcr: (file: File) => void;
}) {
  return (
    <div className="space-y-3 fade-in">
      <button onClick={onBack} className="text-sm text-emerald-800 underline">← {t(lang, 'backToQueue')}</button>
      {!entry ? (
        <p className="text-sm text-emerald-600">{t(lang, 'loading')}</p>
      ) : (
        <>
          <div className="card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-black text-xl text-emerald-900">{entry.token}</span>
              <span className={`text-xs font-bold rounded-full px-2 py-1 border ${LEVEL_STYLE[entry.triage_level ?? ''] ?? ''}`}>
                {entry.triage_level}
              </span>
            </div>
            {entry.summary && (
              <>
                <p className="font-semibold text-emerald-900">{entry.summary.chief_complaint}</p>
                <p className="text-sm text-emerald-800">
                  {t(lang, 'duration')}: {entry.summary.duration} · {t(lang, 'severity')}: {entry.summary.severity}/10
                </p>
                {entry.summary.relevant_history.length > 0 && (
                  <p className="text-sm text-emerald-800">{t(lang, 'relevantHistory')}: {entry.summary.relevant_history.join(', ')}</p>
                )}
              </>
            )}
            {entry.transcript && (
              <p className="text-sm text-emerald-700 border-l-2 border-emerald-200 pl-2 italic">"{entry.transcript}"</p>
            )}
            {entry.source_tags && entry.source_tags.length > 0 && (
              <p className="text-xs text-emerald-600">
                {t(lang, 'sourceTags')}: {entry.source_tags.map((s) => `${s.claim} (${s.source})`).join(' · ')}
              </p>
            )}
            {entry.prior_history && (
              <p className="text-sm text-emerald-800">
                {t(lang, 'priorRecords')}: {entry.prior_history.conditions.join(', ') || '—'} · {entry.prior_history.medicines.join(', ') || '—'}
              </p>
            )}
            {entry.approved_by && <p className="text-xs text-emerald-600">Approved by {entry.approved_by}</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={onApprove} disabled={busy || !entry.summary} className="btn-touch !min-h-[52px] bg-emerald-600 text-white disabled:opacity-50 flex items-center justify-center gap-2">
              <Stethoscope className="w-5 h-5" /> {t(lang, 'approve')}
            </button>
            <label className="btn-touch !min-h-[52px] bg-white border-2 border-emerald-300 text-emerald-800 flex items-center justify-center gap-2 cursor-pointer">
              <ClipboardList className="w-5 h-5" /> {t(lang, 'uploadImage')}
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onOcr(f);
                }}
              />
            </label>
          </div>

          <div className="card p-3 space-y-2">
            <p className="text-sm font-bold text-emerald-900">{t(lang, 'overridePriority')}</p>
            <div className="grid grid-cols-3 gap-2">
              {['ROUTINE', 'URGENT', 'EMERGENCY'].map((lv) => (
                <button
                  key={lv}
                  onClick={() => onOverride(lv)}
                  disabled={busy || lv === entry.triage_level}
                  className={`btn-touch !min-h-[44px] !text-xs border-2 disabled:opacity-40 ${LEVEL_STYLE[lv]}`}
                >
                  {lv}
                </button>
              ))}
            </div>
          </div>

          {entry.ocr_records && entry.ocr_records.length > 0 && (
            <div className="card p-3 space-y-1">
              <p className="text-sm font-bold text-emerald-900">{t(lang, 'ocrPrescriptions')}</p>
              {entry.ocr_records.map((r, i) => (
                <p key={i} className="text-sm text-emerald-800">
                  {r.medicines.map((m) => `${m.name} ${m.dosage}`).join(', ') || r.header}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- RECEPTION (token numbers only, manual reorder) ----------
export function ReceptionView({ lang }: { lang: LangCode }) {
  const { queue, error, refresh } = useStaffQueue();
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<string[]>([]);

  const rows = order.length === queue.length && queue.every((r) => r.id && order.includes(r.id))
    ? order.map((id) => queue.find((r) => r.id === id)!)
    : queue;

  function move(id: string, dir: -1 | 1) {
    const ids = rows.map((r) => r.id!);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setOrder(ids);
  }

  async function save() {
    setBusy(true);
    try {
      await staffReorder(order);
      setOrder([]);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="font-bold text-emerald-900">{t(lang, 'receptionQueue')}</h2>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {rows.map((row, i) => (
        <div key={row.id ?? row.token} className="card p-3 flex items-center gap-3">
          <span className="font-black text-lg text-emerald-900">{row.token}</span>
          <span className={`text-xs font-bold rounded-full px-2 py-1 border ${LEVEL_STYLE[row.triage_level ?? ''] ?? ''}`}>
            {row.triage_level}
          </span>
          <span className="text-xs text-emerald-600 mr-auto">#{row.position}</span>
          <button onClick={() => row.id && move(row.id, -1)} disabled={i === 0} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300 disabled:opacity-30">
            <ArrowUp className="w-4 h-4" />
          </button>
          <button onClick={() => row.id && move(row.id, 1)} disabled={i === rows.length - 1} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300 disabled:opacity-30">
            <ArrowDown className="w-4 h-4" />
          </button>
        </div>
      ))}
      {order.length > 0 && (
        <button onClick={save} disabled={busy} className="btn-touch w-full bg-emerald-700 text-white flex items-center justify-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t(lang, 'queueUpdated')}
        </button>
      )}
    </div>
  );
}

// ---------- ADMIN (capacity, emergency response, ASV legs, stock) ----------
export function AdminView({ lang }: { lang: LangCode }) {
  const [hospital, setHospital] = useState<AdminOverview['hospital']>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stock, setStock] = useState({ batch_code: '', quantity: '0', expiry_date: '' });
  const [log, setLog] = useState<{ id: string; ts: string; role: string; action: string; patient_ref: string }[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [ov, audit] = await Promise.all([staffAdminOverview(), staffAudit()]);
      setOverview(ov);
      setHospital(ov.hospital);
      setLog(audit.log ?? []);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useRefreshSignal(refresh);
  usePollFallback(refresh);

  async function capacity(field: 'icu_beds_available' | 'ventilators_available', delta: number) {
    setBusy(true);
    try {
      await staffCapacity(field, delta);
      setHospital((h) => (h ? { ...h, [field]: Math.max(0, h[field] + delta) } : h));
    } finally {
      setBusy(false);
    }
  }

  async function respond(requestId: string, action: 'ACCEPT' | 'DECLINE', reason?: string) {
    setBusy(true);
    try {
      await emergencyRespond(requestId, action, reason);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function legAction(legId: string, action: 'ACCEPT' | 'DECLINE' | 'DISPATCH' | 'RECEIVE') {
    setBusy(true);
    try {
      if (action === 'ACCEPT') await asvRespond(legId, 'ACCEPT');
      if (action === 'DECLINE') await asvRespond(legId, 'DECLINE', 'Cannot supply');
      if (action === 'DISPATCH') await asvDispatch(legId, 'Courier');
      if (action === 'RECEIVE') await asvReceive(legId, 'Staff');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveStock() {
    if (!stock.batch_code || !stock.expiry_date) return;
    setBusy(true);
    try {
      await asvStock({ batch_code: stock.batch_code, quantity: Number(stock.quantity) || 0, expiry_date: stock.expiry_date });
      setStock({ batch_code: '', quantity: '0', expiry_date: '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-700">{error}</p>}

      <section className="card p-4 space-y-2">
        <h2 className="font-bold text-emerald-900">{t(lang, 'adminCapacity')}</h2>
        {hospital ? (
          <>
            <p className="text-sm text-emerald-800">{hospital.name}</p>
            <div className="flex items-center justify-between">
              <span className="text-emerald-800">{t(lang, 'icuBeds')}</span>
              <span className="flex items-center gap-2">
                <button onClick={() => capacity('icu_beds_available', -1)} disabled={busy} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">−</button>
                <span className="font-bold text-lg text-emerald-900 w-8 text-center">{hospital.icu_beds_available}</span>
                <button onClick={() => capacity('icu_beds_available', 1)} disabled={busy} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">+</button>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-emerald-800">{t(lang, 'ventilators')}</span>
              <span className="flex items-center gap-2">
                <button onClick={() => capacity('ventilators_available', -1)} disabled={busy} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">−</button>
                <span className="font-bold text-lg text-emerald-900 w-8 text-center">{hospital.ventilators_available}</span>
                <button onClick={() => capacity('ventilators_available', 1)} disabled={busy} className="btn-touch !min-h-[44px] !min-w-[44px] bg-emerald-50 border border-emerald-300">+</button>
              </span>
            </div>
            <p className="text-emerald-800">{t(lang, 'specialists')}: {hospital.specialists_on_duty.join(', ') || '—'}</p>
            <p className="text-emerald-800">
              {t(lang, 'bloodStock')}: {Object.entries(hospital.blood_stock).map(([bg, units]) => `${bg}: ${units}`).join(' · ')}
            </p>
          </>
        ) : (
          <p className="text-sm text-emerald-600">{t(lang, 'loading')}</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-bold text-emerald-900">{t(lang, 'incomingRequests')}</h2>
        {(overview?.my_emergencies ?? []).length === 0 && <p className="text-sm text-emerald-600">No active emergency requests.</p>}
        {(overview?.my_emergencies ?? []).map((r) => {
          const row = r as { id: string; kind: string; status: string; current_target_hospital_id: string; accepted_hospital_id: string | null; emergency_summary: IntakeSummaryLike | null; target_deadline_at: string };
          const isTarget = row.current_target_hospital_id && !row.accepted_hospital_id;
          return (
            <div key={row.id} className="card p-4 space-y-2 border-2 border-red-300 bg-red-50">
              <p className="font-bold text-red-900">{row.kind} · {row.status}</p>
              {row.emergency_summary?.summary && (
                <p className="text-sm text-red-800">
                  {row.emergency_summary.summary.chief_complaint} — {t(lang, 'severity')} {row.emergency_summary.summary.severity}/10
                </p>
              )}
              {isTarget && (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => respond(row.id, 'ACCEPT')} disabled={busy} className="btn-touch !min-h-[52px] bg-emerald-600 text-white disabled:opacity-50">
                    {t(lang, 'accept')}
                  </button>
                  <button onClick={() => respond(row.id, 'DECLINE', 'No capacity')} disabled={busy} className="btn-touch !min-h-[52px] bg-red-600 text-white disabled:opacity-50">
                    {t(lang, 'decline')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {(overview?.other_emergencies_count ?? 0) > 0 && (
          <p className="text-xs text-emerald-600">{overview!.other_emergencies_count} other emergency request(s) in the city.</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-bold text-emerald-900 flex items-center gap-2"><Activity className="w-5 h-5" /> ASV transfers for your hospital</h2>
        {(overview?.legs ?? []).length === 0 && <p className="text-sm text-emerald-600">No transfer legs.</p>}
        {(overview?.legs ?? []).map((l) => {
          const leg = l as { id: string; status: string; vials: number; batch_id: string; deadline_at: string | null; transfer_requests: { patient_ref: string; vials_needed: number } | null };
          return (
            <div key={leg.id} className="card p-3 space-y-2">
              <p className="font-bold text-emerald-900">{leg.transfer_requests?.patient_ref ?? '—'} — {leg.vials} vial(s)</p>
              <p className="text-xs text-emerald-700 flex items-center gap-1">
                <Timer className="w-3 h-3" /> {leg.status}{leg.deadline_at ? ` · deadline ${new Date(leg.deadline_at).toLocaleTimeString()}` : ''}
              </p>
              {leg.status === 'REQUESTED' && (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => legAction(leg.id, 'ACCEPT')} disabled={busy} className="btn-touch !min-h-[48px] bg-emerald-600 text-white">{t(lang, 'accept')}</button>
                  <button onClick={() => legAction(leg.id, 'DECLINE')} disabled={busy} className="btn-touch !min-h-[48px] bg-red-600 text-white">{t(lang, 'decline')}</button>
                </div>
              )}
              {leg.status === 'ACCEPTED' && (
                <button onClick={() => legAction(leg.id, 'DISPATCH')} disabled={busy} className="btn-touch w-full !min-h-[48px] bg-emerald-700 text-white">Dispatch</button>
              )}
              {leg.status === 'DISPATCHED' && (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => legAction(leg.id, 'RECEIVE')} disabled={busy} className="btn-touch !min-h-[48px] bg-emerald-600 text-white">Receive</button>
                  <button onClick={() => legAction(leg.id, 'DISPATCH')} disabled={busy} className="btn-touch !min-h-[48px] bg-white border-2 border-emerald-300 text-emerald-800">Handover</button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="card p-4 space-y-2">
        <h2 className="font-bold text-emerald-900 flex items-center gap-2"><Package className="w-5 h-5" /> ASV stock update</h2>
        <input value={stock.batch_code} onChange={(e) => setStock((s) => ({ ...s, batch_code: e.target.value }))} placeholder="Batch code" className="w-full border-2 border-emerald-200 rounded-xl px-3 min-h-[48px]" />
        <div className="grid grid-cols-2 gap-2">
          <input value={stock.quantity} onChange={(e) => setStock((s) => ({ ...s, quantity: e.target.value }))} inputMode="numeric" placeholder="Quantity" className="w-full border-2 border-emerald-200 rounded-xl px-3 min-h-[48px]" />
          <input value={stock.expiry_date} onChange={(e) => setStock((s) => ({ ...s, expiry_date: e.target.value }))} type="date" className="w-full border-2 border-emerald-200 rounded-xl px-3 min-h-[48px]" />
        </div>
        <button onClick={saveStock} disabled={busy} className="btn-touch w-full bg-emerald-700 text-white">Save stock</button>
      </section>

      <AuditLog lang={lang} log={log} />
    </div>
  );
}

interface IntakeSummaryLike {
  summary?: { chief_complaint?: string; severity?: number };
}

export function AuditLog({ lang, log }: { lang: LangCode; log: { id: string; ts: string; role: string; action: string; patient_ref: string }[] }) {
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
