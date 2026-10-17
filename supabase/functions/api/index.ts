// Swasthya Setu edge function — Gemini proxy + role-enforced staff API.
// The GEMINI_API_KEY secret never reaches the browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gemini-3.8-flash"; // change this if your key lists a different model
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const LANG_NAME: Record<string, string> = {
  "en-IN": "English (India)",
  "hi-IN": "Hindi (Devanagari)",
  "ta-IN": "Tamil",
  "bn-IN": "Bengali",
  "mr-IN": "Marathi",
  "te-IN": "Telugu",
};

async function geminiJson(prompt: string, imageBase64?: string, imageMime?: string): Promise<Record<string, unknown> | null> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return null; // demo mode — caller falls back to mock data
  const parts: Record<string, unknown>[] = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: imageMime ?? "image/jpeg", data: imageBase64 } });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

// ---------- mock fallbacks (used when no GEMINI_API_KEY is configured) ----------
const MOCK_INTAKE: Record<string, unknown> = {
  triage_level: "URGENT",
  emergency_reason: null,
  summary: {
    chief_complaint: "Fever and body ache (mock)",
    duration: "2 days (mock)",
    severity: 5,
    relevant_history: ["Patient reported fever since morning (voice)", "History of diabetes (history)"],
  },
  source_tags: [
    { claim: "Fever for 2 days", source: "voice" },
    { claim: "Diabetic", source: "history" },
  ],
  followup_questions: [
    "Is there any chest pain or breathlessness?",
    "Have you taken any medicine so far?",
    "Are you able to drink water and eat?",
  ],
};
const MOCK_EMERGENCY: Record<string, unknown> = {
  triage_level: "EMERGENCY",
  emergency_reason: "Chest pain with sweating (mock)",
  summary: {
    chief_complaint: "Suspected cardiac event (mock)",
    duration: "30 minutes (mock)",
    severity: 9,
    relevant_history: ["Family reported severe chest pain (voice)"],
  },
  source_tags: [{ claim: "Severe chest pain", source: "voice" }],
  followup_questions: [],
};
const MOCK_OCR: Record<string, unknown> = {
  medicines: [
    { name: "Paracetamol", dosage: "650mg twice daily", ocr_confidence: 93, needs_review: false },
    { name: "Azithromycin", dosage: "500mg once daily", ocr_confidence: 72, needs_review: true },
  ],
  header: "Mock demo prescription header",
  warnings: ["Demo mode: this is mock OCR output, not read from your image."],
};

// ---------- helpers ----------
async function logAudit(role: string, action: string, patientRef: string, details?: Record<string, unknown>) {
  await supabase.from("audit_log").insert({ role, action, patient_ref: patientRef, details: details ?? null });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function bad(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// Role-based field stripping: only DOCTOR sees clinical content.
function filterQueueForRole(rows: Record<string, unknown>[], role: string) {
  if (role === "DOCTOR") return rows;
  if (role === "ADMIN") return rows.map((r) => ({ id: r.id, token: r.token, status: r.status, triage_level: r.triage_level, priority_score: r.priority_score, created_at: r.created_at, patient_label: "restricted" }));
  // RECEPTION: tokens + position only, no clinical data
  return rows.map((r) => ({ id: r.id, token: r.token, status: r.status, created_at: r.created_at, priority_score: r.priority_score }));
}

function baseScore(level: string): number {
  return level === "EMERGENCY" ? 100 : level === "URGENT" ? 60 : 20;
}
function waitingPoints(entry: { created_at: string }): number {
  const mins = (Date.now() - new Date(entry.created_at).getTime()) / 60000;
  return Math.min(20, Math.round(mins / 2));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/api/, "") || "/";
    if (path === "/debug") {
      return json({ pathname: url.pathname, path });
    }
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // ---------- AI endpoints ----------
    if (path === "/intake" || path === "/followup" || path === "/emergency-summary") {
      const lang: string = body.language ?? "en-IN";
      const langName = LANG_NAME[lang] ?? lang;
      const isEmergencySummary = path === "/emergency-summary";
      const historyPart = (body.prior_history ? `\nPrior records (DEMO DATA): ${JSON.stringify(body.prior_history)}` : "");
      const answersPart = body.answers?.length ? `\nFollow-up answers: ${JSON.stringify(body.answers)}` : "";
      const prompt = `You are a hospital triage intake assistant for a hackathon prototype. Patient speaks ${langName}.
Transcript: """${body.transcript ?? ""}"""${answersPart}${historyPart}
Rules:
- Respond ENTIRELY in ${langName} for any patient-facing strings (summary, questions, tags). Keep JSON keys in English.
- triage_level is ROUTINE, URGENT or EMERGENCY. Use EMERGENCY for chest pain, breathlessness, unconsciousness, heavy bleeding, stroke signs, suicidal intent.
- emergency_reason: string or null.
- summary: {chief_complaint, duration, severity (1-10), relevant_history (string[])}.
- source_tags: [{claim, source}] where source is "voice", "history" or "ocr".
- followup_questions: max 3 short questions in ${langName} suitable for a low-literacy patient; empty array if enough information or if this is an emergency summary.
- This is NOT a diagnosis; it is structured intake only.
Return JSON only.
${isEmergencySummary ? "This is an EMERGENCY request from a family member: produce a structured emergency summary with followup_questions: [] and triage_level EMERGENCY." : ""}`;
      let result: Record<string, unknown> | null = null;
      try {
        result = await geminiJson(prompt);
      } catch (e) {
        return json({ error: `AI service error: ${(e as Error).message}`, mock: false }, 502);
      }
      if (!result) {
        result = structuredClone(isEmergencySummary ? MOCK_EMERGENCY : MOCK_INTAKE);
        return json({ ...result, mock: true });
      }
      const summary = (result.summary as Record<string, unknown> | undefined) ?? {};
      const sev = Number(summary.severity);
      if (!Number.isFinite(sev)) summary.severity = 5;
      summary.chief_complaint = String(summary.chief_complaint ?? "—");
      summary.duration = String(summary.duration ?? "—");
      result.summary = summary;
      result.source_tags = Array.isArray(result.source_tags) ? result.source_tags : [];
      result.followup_questions = Array.isArray(result.followup_questions) ? result.followup_questions.slice(0, 3) : [];
      return json({ ...result, mock: false });
    }

    if (path === "/ocr") {
      const { imageBase64, mime } = body;
      if (!imageBase64) return bad("imageBase64 required");
      const prompt = `Read this prescription image (OCR) for a hospital prototype. Return JSON: {"medicines":[{"name":string,"dosage":string,"ocr_confidence":number 0-100,"needs_review":boolean}],"header":string,"warnings":string[]}. Set needs_review true whenever ocr_confidence < 85. Include legibility problems in warnings. Do not invent medicines you cannot actually see; lower confidence instead.`;
      let result: Record<string, unknown> | null = null;
      try {
        result = await geminiJson(prompt, imageBase64, mime);
      } catch (e) {
        return json({ error: `AI service error: ${(e as Error).message}`, mock: false }, 502);
      }
      if (!result) {
        result = structuredClone(MOCK_OCR);
        return json({ ...result, mock: true });
      }
      const meds = (result.medicines as { ocr_confidence: number }[] | undefined) ?? [];
      result.medicines = meds.map((m) => ({ ...m, needs_review: m.ocr_confidence < 85 }));
      return json({ ...result, mock: false });
    }

    // ---------- staff auth ----------
    if (path === "/staff/login") {
      const { username, password } = body;
      const { data, error } = await supabase
        .from("staff_users")
        .select("id, username, password, role, display_name")
        .eq("username", username)
        .maybeSingle();
      if (error) return bad(error.message, 500);
      if (!data || data.password !== password) return bad("Invalid demo credentials", 401);
      await logAudit(data.role, "STAFF_LOGIN", data.username);
      const { password: _pw, ...safe } = data;
      return json({ user: safe });
    }

    // ---------- staff queue (server-enforced role checks) ----------
    if (path === "/staff/queue") {
      const role: string = body.role ?? "";
      if (!["DOCTOR", "RECEPTION", "ADMIN"].includes(role)) return bad("Forbidden", 403);
      const { data, error } = await supabase
        .from("queue_entries")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) return bad(error.message, 500);
      const sorted = [...(data ?? [])].sort(
        (a, b) => (baseScore(b.triage_level) + waitingPoints(b)) - (baseScore(a.triage_level) + waitingPoints(a)),
      );
      return json({ queue: filterQueueForRole(sorted as Record<string, unknown>[], role) });
    }

    if (path === "/staff/entry") {
      const role: string = body.role ?? "";
      const id: string = body.id ?? "";
      if (role !== "DOCTOR") return bad("Only doctors can view clinical summaries", 403);
      const { data, error } = await supabase.from("queue_entries").select("*").eq("id", id).maybeSingle();
      if (error) return bad(error.message, 500);
      if (!data) return bad("Not found", 404);
      await logAudit("DOCTOR", "VIEW_ENTRY", data.abha_id ?? data.patient_label, { entry: id });
      return json({ entry: data });
    }

    if (path === "/staff/action") {
      const { role, action, id, value, order } = body;
      if (!["DOCTOR", "RECEPTION", "ADMIN"].includes(role)) return bad("Forbidden", 403);

      if (action === "APPROVE" || action === "EDIT") {
        if (role !== "DOCTOR") return bad("Only doctors can approve or edit", 403);
        const patch = action === "APPROVE" ? { status: "SENT_TO_DOCTOR" } : { summary: body.summary, transcript: body.transcript };
        const { error } = await supabase.from("queue_entries").update(patch).eq("id", id);
        if (error) return bad(error.message, 500);
        await logAudit(role, action, id, { value });
        return json({ ok: true });
      }
      if (action === "OVERRIDE") {
        if (role !== "DOCTOR") return bad("Only doctors can override priority", 403);
        const { error } = await supabase.from("queue_entries").update({ triage_level: value, priority_score: baseScore(value) }).eq("id", id);
        if (error) return bad(error.message, 500);
        await logAudit(role, "OVERRIDE_PRIORITY", id, { to: value });
        return json({ ok: true });
      }
      if (action === "REORDER") {
        if (role !== "RECEPTION") return bad("Only reception can reorder the queue", 403);
        for (const [i, entryId] of (order as string[]).entries()) {
          await supabase.from("queue_entries").update({ priority_score: 1000 - i }).eq("id", entryId);
        }
        await logAudit(role, "REORDER_QUEUE", "", { order });
        return json({ ok: true });
      }
      return bad("Unknown action");
    }

    // ---------- emergency responses (hospital admin) ----------
    if (path === "/emergency/respond") {
      const { role, request_id, hospital_id, hospital_name, action, reason } = body;
      if (role !== "ADMIN") return bad("Only hospital admin can respond", 403);
      const { data: reqRow } = await supabase.from("emergency_requests").select("*").eq("id", request_id).maybeSingle();
      if (!reqRow) return bad("Not found", 404);
      if (reqRow.status !== "BROADCASTING") return bad("Request already resolved", 409);
      const responses = [...(reqRow.responses ?? []), { hospital_id, hospital_name, action, reason, at: new Date().toISOString() }];
      if (action === "ACCEPT") {
        const { error } = await supabase.from("emergency_requests").update({ status: "ACCEPTED", accepted_hospital_id: hospital_id, responses }).eq("id", request_id);
        if (error) return bad(error.message, 500);
        await logAudit(role, "EMERGENCY_ACCEPT", request_id, { hospital: hospital_name });
        return json({ ok: true, status: "ACCEPTED" });
      }
      const { error } = await supabase.from("emergency_requests").update({ responses }).eq("id", request_id);
      if (error) return bad(error.message, 500);
      await logAudit(role, "EMERGENCY_DECLINE", request_id, { hospital: hospital_name, reason });
      return json({ ok: true, status: "BROADCASTING" });
    }

    // ---------- audit ----------
    if (path === "/audit") {
      const { role, action, patient_ref } = body;
      if (!role || !action) return bad("role and action required");
      await logAudit(role, action, patient_ref ?? "");
      return json({ ok: true });
    }
    if (path === "/audit/list") {
      const { data } = await supabase.from("audit_log").select("*").order("ts", { ascending: false }).limit(50);
      return json({ log: data ?? [] });
    }

    // ---------- public: data access ----------
    if (path === "/patient") {
      const { abha } = body;
      const { data, error } = await supabase.from("patients").select("*").eq("abha_id", abha).maybeSingle();
      if (error) return bad(error.message, 500);
      if (!data) return json({ patient: null });
      await logAudit("PATIENT", "VIEW_RECORDS", abha);
      return json({ patient: data });
    }

    return bad("Not found", 404);
  } catch (err) {
    return json({ error: (err as Error).message ?? "Server error" }, 500);
  }
});
