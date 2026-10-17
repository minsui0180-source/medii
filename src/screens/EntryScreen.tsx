import { useState } from 'react';
import { MapPin, Keyboard, Stethoscope } from 'lucide-react';
import { LANGUAGES, type LangCode } from '@/types';
import { t } from '@/lib/i18n';
import { getUserLocation } from '@/lib/helpers';
import { DemoBanner } from '@/components/Chrome';

export interface EntryResult {
  lang: LangCode;
  location: { lat: number; lng: number } | null;
  locationLabel: string;
  path: 'GREEN' | 'YELLOW' | 'RED' | 'STAFF';
}

export function EntryScreen({ onStart }: { onStart: (r: EntryResult) => void }) {
  const [lang, setLang] = useState<LangCode>('en-IN');
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [label, setLabel] = useState('');
  const [manual, setManual] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [locError, setLocError] = useState('');

  async function requestLocation() {
    setLocError('');
    try {
      const loc = await getUserLocation();
      setLocation(loc);
      setLabel(`${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`);
    } catch {
      setLocError(t(lang, 'locationDenied'));
      setManualMode(true);
    }
  }

  function submitManual() {
    if (!manual.trim()) return;
    // Demo: approximate Delhi centre for any manual entry
    setLocation({ lat: 28.6139, lng: 77.209 });
    setLabel(manual.trim());
  }

  const ready = location !== null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6 fade-in">
      <DemoBanner lang={lang} />

      {/* 1. Language */}
      <section className="card p-4">
        <h2 className="font-bold text-lg mb-3 text-emerald-900">{t(lang, 'chooseLanguage')}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={`btn-touch !min-h-[52px] border-2 ${
                lang === l.code
                  ? 'bg-emerald-700 text-white border-emerald-700'
                  : 'bg-white text-emerald-900 border-emerald-200 hover:border-emerald-400'
              }`}
            >
              {l.native}
            </button>
          ))}
        </div>
      </section>

      {/* 2. Location */}
      <section className="card p-4 space-y-3">
        <h2 className="font-bold text-lg text-emerald-900 flex items-center gap-2">
          <MapPin className="w-5 h-5" /> Location
        </h2>
        {ready ? (
          <p className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm font-medium">
            {label}
          </p>
        ) : manualMode ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder={t(lang, 'cityPinPlaceholder')}
                className="flex-1 border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
              />
              <button onClick={submitManual} className="btn-touch bg-emerald-700 text-white px-5">
                {t(lang, 'continue')}
              </button>
            </div>
            {locError && <p className="text-sm text-red-700">{locError}</p>}
          </div>
        ) : (
          <div className="space-y-2">
            <button onClick={requestLocation} className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white flex items-center justify-center gap-2">
              <MapPin className="w-5 h-5" /> {t(lang, 'allowLocation')}
            </button>
            <button
              onClick={() => setManualMode(true)}
              className="w-full text-sm text-emerald-800 underline flex items-center justify-center gap-1 py-2"
            >
              <Keyboard className="w-4 h-4" /> {t(lang, 'manualLocation')}
            </button>
          </div>
        )}
      </section>

      {/* 3. Three paths */}
      <section className="grid gap-3">
        <button
          disabled={!ready}
          onClick={() => onStart({ lang, location, locationLabel: label, path: 'RED' })}
          className="btn-touch !min-h-[88px] !text-xl bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white flex flex-col items-center justify-center gap-1 pulse-red"
        >
          <span>{t(lang, 'emergency')}</span>
          <span className="text-xs font-normal opacity-90">{t(lang, 'emergencySubtitle')}</span>
        </button>
        <button
          disabled={!ready}
          onClick={() => onStart({ lang, location, locationLabel: label, path: 'YELLOW' })}
          className="btn-touch !min-h-[88px] bg-amber-400 hover:bg-amber-500 disabled:opacity-40 text-amber-950 flex flex-col items-center justify-center gap-1"
        >
          <span>{t(lang, 'urgent')}</span>
          <span className="text-xs font-normal opacity-80">{t(lang, 'urgentSubtitle')}</span>
        </button>
        <button
          disabled={!ready}
          onClick={() => onStart({ lang, location, locationLabel: label, path: 'GREEN' })}
          className="btn-touch !min-h-[88px] bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white flex flex-col items-center justify-center gap-1"
        >
          <span>{t(lang, 'routine')}</span>
          <span className="text-xs font-normal opacity-90">{t(lang, 'routineSubtitle')}</span>
        </button>
      </section>

      <button
        onClick={() => onStart({ lang, location, locationLabel: label, path: 'STAFF' })}
        className="w-full flex items-center justify-center gap-2 text-sm text-emerald-800 underline py-2"
      >
        <Stethoscope className="w-4 h-4" /> {t(lang, 'doctorLogin')}
      </button>
    </div>
  );
}
