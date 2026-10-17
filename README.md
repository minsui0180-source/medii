# Swasthya Setu

Multilingual patient–hospital triage app for a hackathon demo. Mobile-first, voice-first, with AI triage, live queue, emergency broadcast, and role-based staff dashboards.

## How to add GEMINI_API_KEY

The app works without a key (AI responses are mock data, clearly labeled "DEMO DATA"). To enable real AI:

1. Open this project's environment settings (where environment variables are managed).
2. Add a secret named `GEMINI_API_KEY` with your Google Gemini API key.
3. Redeploy / restart. The edge function reads it server-side — the key never reaches the browser.
4. If the first AI call returns a 404, the model ID needs changing: edit `MODEL` at the top of `supabase/functions/api/index.ts` to an ID your key's model list shows (e.g. another `gemini-2.5-flash` variant), then redeploy the edge function.

## How to switch the model

`MODEL` is a single constant at the top of `supabase/functions/api/index.ts` — change the string and redeploy.

## What is mocked (DEMO DATA)

- 6 Delhi-NCR hospitals (fictional names), ICU/ventilator/blood stock values — stored in the database, editable in the Admin view.
- 2 ABHA patients with prior records: `91-1234-5678-9012` (Ramesh Kumar), `91-8812-0000-1111` (Sunita Devi).
- Staff logins (server-checked): `doctor1` / `reception1` / `admin1`, password `demo123`.
- Ambulance dispatch status and ETA.
- Without `GEMINI_API_KEY`: all AI triage/OCR output is mock data flagged with a badge; with a key, real Gemini responses are used and labeled "AI suggestion for clinician review".

## Demo script (5 steps)

1. **Red path (no login):** Home → Emergency → tap the big "Call Ambulance" → mock dispatch with GPS + 3 nearest emergency hospitals. (Works instantly, no OTP.)
2. **Red path (family broadcast):** On the same screen, enter ABHA `91-1234-5678-9012` → answer the yes/no questions → request broadcasts to hospitals with a 90-second countdown per hospital.
3. **Hospital accepts:** Log in as `admin1` (Admin view) → open the incoming emergency card → ACCEPT. The patient screen flips to "Accepted by …" with the hospital's address.
4. **Green path:** Home → Routine check-up → ABHA `91-1234-5678-9012` shows prior records (DEMO DATA) → pick a hospital (try "Recommend a hospital for me") → tap the mic and describe symptoms (or type) → answer follow-ups → get token + live queue position.
5. **Doctor dashboard:** Log in as `doctor1` → open the patient from the queue → summary, source tags, prior history, OCR records, and the AI suggestion (clinician-review only) → Approve / Edit / Override priority. Check the audit log at the bottom of every staff view.

## Tech notes

- Frontend: React + Vite + Tailwind + lucide-react; speech-to-text/read-back via the browser Web Speech API.
- Backend: Supabase — Postgres tables (hospitals, patients, queue_entries, emergency_requests, audit_log, staff_users) with row-level security, realtime updates for queue/emergency status, and one edge function (`api`) that proxies all Gemini calls with server-side role enforcement.
