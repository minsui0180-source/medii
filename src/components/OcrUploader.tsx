import { useRef, useState } from 'react';
import { Upload, Loader2, AlertTriangle } from 'lucide-react';
import { ocrPrescription, type OcrRecord } from '@/lib/api';
import type { LangCode } from '@/types';
import { t } from '@/lib/i18n';
import { compressImage } from '@/lib/helpers';

export function OcrUploader({
  lang,
  onSaved,
}: {
  lang: LangCode;
  onSaved: (record: OcrRecord) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [record, setRecord] = useState<OcrRecord | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError('');
    try {
      const { base64, mime } = await compressImage(file);
      const data = await ocrPrescription({ imageBase64: base64, mime });
      const rec: OcrRecord = {
        file: file.name,
        date: new Date().toISOString().slice(0, 10),
        medicines: data.medicines ?? [],
        header: data.header,
        warnings: data.warnings,
      };
      setRecord(rec);
      onSaved(rec);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg === 'imageTooLarge' ? 'Image is larger than 5 MB.' : msg || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="font-bold text-emerald-900 flex items-center gap-2">
        <Upload className="w-5 h-5" /> {t(lang, 'ocrUpload')}
      </h3>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="btn-touch w-full bg-white border-2 border-emerald-300 text-emerald-800 hover:border-emerald-500 flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
        {busy ? t(lang, 'loading') : t(lang, 'uploadImage')}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {record && (
        <div className="card p-3 space-y-2 fade-in">
          {record.header && <p className="text-sm text-emerald-900 font-medium">{record.header}</p>}
          {record.medicines.map((m, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-sm border-b border-emerald-100 pb-2 last:border-0">
              <span>
                <span className="font-semibold text-emerald-900">{m.name}</span>{' '}
                <span className="text-emerald-700">{m.dosage}</span>
              </span>
              <span
                className={`text-xs font-bold rounded-full px-2 py-0.5 whitespace-nowrap ${
                  m.needs_review ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'
                }`}
              >
                {m.ocr_confidence}% {t(lang, 'ocrConfidence')}
                {m.needs_review ? ` — ${t(lang, 'needsReview')}` : ''}
              </span>
            </div>
          ))}
          {record.warnings && record.warnings.length > 0 && (
            <p className="text-xs text-amber-800 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {record.warnings.join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
