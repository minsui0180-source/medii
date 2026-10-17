import { useMemo, useState } from 'react';
import { MapPin, Sparkles, CheckCircle2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode, Hospital } from '@/types';
import { haversineKm } from '@/lib/helpers';
import { DemoBadge } from '@/components/Chrome';

interface Props {
  lang: LangCode;
  location: { lat: number; lng: number };
  hospitals: Hospital[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNext: () => void;
}

export function HospitalChooser({ lang, location, hospitals, selected, onSelect, onNext }: Props) {
  const [recommendation, setRecommendation] = useState<string | null>(null);

  const ranked = useMemo(
    () =>
      hospitals
        .map((h) => ({ h, km: haversineKm(location, h) }))
        .sort((a, b) => a.km - b.km),
    [hospitals, location],
  );

  function recommend() {
    // Rank by distance (0-50 pts), shorter queue (0-30), more ICU beds (0-20)
    const scored = hospitals.map((h) => {
      const km = haversineKm(location, h);
      const distPts = Math.max(0, 50 - km * 2);
      const queuePts = Math.max(0, 30 - h.queue_length * 1.5);
      const bedPts = Math.min(20, h.icu_beds_available * 2);
      return { h, km, total: distPts + queuePts + bedPts };
    });
    scored.sort((a, b) => b.total - a.total);
    const best = scored[0];
    if (best) {
      onSelect(best.h.id);
      setRecommendation(
        `${best.h.name} — ${best.km.toFixed(1)} ${t(lang, 'kmAway')}, ${best.h.queue_length} ${t(lang, 'queueLen')}, ${best.h.icu_beds_available} ICU. (distance + queue + capacity)`,
      );
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-emerald-900">{t(lang, 'chooseHospital')}</h2>
        <DemoBadge />
      </div>

      <button
        onClick={recommend}
        className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white flex items-center justify-center gap-2"
      >
        <Sparkles className="w-5 h-5" /> {t(lang, 'recommend')}
      </button>
      {recommendation && (
        <p className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl px-3 py-2">
          {t(lang, 'whyRecommended')} {recommendation}
        </p>
      )}

      <ul className="space-y-3">
        {ranked.map(({ h, km }) => (
          <li key={h.id}>
            <button
              onClick={() => onSelect(h.id)}
              className={`w-full text-left card p-4 transition border-2 ${
                selected === h.id ? 'border-emerald-600 bg-emerald-50' : 'hover:border-emerald-300'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-emerald-900 flex items-center gap-1">
                    {selected === h.id && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                    {h.name}
                  </p>
                  <p className="text-xs text-emerald-700">{h.address}</p>
                  <p className="text-xs text-emerald-600 mt-1">{h.specialties.join(' · ')}</p>
                </div>
                <div className="text-right text-sm whitespace-nowrap">
                  <p className="text-emerald-800 font-semibold flex items-center gap-1">
                    <MapPin className="w-4 h-4" /> {km.toFixed(1)} {t(lang, 'kmAway')}
                  </p>
                  <p className="text-amber-700">
                    {h.queue_length} {t(lang, 'queueLen')}
                  </p>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <button
        onClick={onNext}
        disabled={!selected}
        className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-40"
      >
        {t(lang, 'continue')}
      </button>
    </div>
  );
}
