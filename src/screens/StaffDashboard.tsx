import { useState } from 'react';
import { LogOut, Loader2, ShieldAlert } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LangCode, StaffUser } from '@/types';
import { staffLogin, setStaffToken, clearStaffToken } from '@/lib/api';
import { DemoBadge } from '@/components/Chrome';
import { DoctorView, ReceptionView, AdminView } from '@/components/RoleViews';

export function StaffLogin({ lang, onLoggedIn, onBack }: { lang: LangCode; onLoggedIn: (u: StaffUser) => void; onBack: () => void }) {
  const [username, setUsername] = useState('doctor1');
  const [password, setPassword] = useState('demo123');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function login() {
    setBusy(true);
    setError('');
    try {
      const { token, user } = await staffLogin(username, password);
      setStaffToken(token);
      onLoggedIn(user);
    } catch (e) {
      setError((e as Error).message || t(lang, 'errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-4 fade-in">
      <div className="card p-5 space-y-3">
        <h2 className="text-xl font-bold text-emerald-900 flex items-center gap-2">
          <ShieldAlert className="w-5 h-5" /> {t(lang, 'doctorLogin')}
        </h2>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t(lang, 'username')}
          className="w-full border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t(lang, 'password')}
          className="w-full border-2 border-emerald-200 rounded-xl px-3 text-lg min-h-[52px] focus:border-emerald-500 outline-none"
        />
        <button onClick={login} disabled={busy} className="btn-touch w-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 flex items-center justify-center gap-2">
          {busy && <Loader2 className="w-5 h-5 animate-spin" />} {t(lang, 'login')}
        </button>
        <p className="text-xs text-emerald-700">{t(lang, 'loginHint')}</p>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button onClick={onBack} className="text-sm text-emerald-800 underline">
          ← {t(lang, 'goHome')}
        </button>
      </div>
    </div>
  );
}

export function StaffDashboard({ lang, user, onLogout }: { lang: LangCode; user: StaffUser; onLogout: () => void }) {
  function logout() {
    clearStaffToken();
    onLogout();
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-4 fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-emerald-900">{user.display_name}</h1>
          <p className="text-sm text-emerald-700">{user.role} — demo access</p>
        </div>
        <button onClick={logout} className="btn-touch !min-h-[48px] bg-white border-2 border-emerald-300 text-emerald-800 flex items-center gap-2">
          <LogOut className="w-5 h-5" /> {t(lang, 'logout')}
        </button>
      </div>
      <DemoBadge />

      {user.role === 'DOCTOR' && <DoctorView lang={lang} />}
      {user.role === 'RECEPTION' && <ReceptionView lang={lang} />}
      {user.role === 'ADMIN' && <AdminView lang={lang} />}
    </div>
  );
}
