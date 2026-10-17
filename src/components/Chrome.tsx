import { Phone, HeartPulse, Info } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode } from '@/types';

export function Header({ lang, onHome }: { lang: LangCode; onHome: () => void }) {
  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-emerald-900/10">
      <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
        <button onClick={onHome} className="flex items-center gap-2 mr-auto text-left">
          <HeartPulse className="w-8 h-8 text-emerald-700" />
          <span>
            <span className="block font-bold text-lg leading-tight text-emerald-900">{t(lang, 'appName')}</span>
            <span className="block text-xs text-emerald-700">{t(lang, 'tagline')}</span>
          </span>
        </button>
        <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-bold tracking-wide bg-amber-100 text-amber-900 border border-amber-300 rounded-full px-2 py-1">
          <Info className="w-3 h-3" /> DEMO
        </span>
        <a
          href="tel:108"
          className="btn-touch !min-h-[48px] !text-base bg-red-600 hover:bg-red-700 text-white px-4 flex items-center gap-2"
        >
          <Phone className="w-5 h-5" />
          <span className="whitespace-nowrap">108 / 112</span>
        </a>
      </div>
    </header>
  );
}

export function DemoBanner({ lang }: { lang: LangCode }) {
  return (
    <div className="bg-amber-50 border border-amber-300 text-amber-900 text-sm rounded-xl px-3 py-2 flex items-start gap-2">
      <Info className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{t(lang, 'demoBanner')}</span>
    </div>
  );
}

export function DemoBadge({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center text-[10px] font-bold tracking-wide bg-amber-100 text-amber-900 border border-amber-300 rounded-full px-2 py-0.5 uppercase">
      {label ?? 'DEMO DATA'}
    </span>
  );
}
