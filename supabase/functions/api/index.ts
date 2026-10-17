// Swasthya Setu edge function — router + handlers.
// All data access uses the service-role client; the browser never touches tables directly.

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS, EMERGENCY_WINDOW_SEC, LEG_WINDOW_MIN, USE_REAL_HOSPITAL_NAMES } from "../_shared/config.ts";
import { AuthError, hashPassword, requireRole, signToken, type StaffRole } from "../_shared/auth.ts";
import { geminiJson } from "../_shared/gemini.ts";
import { geocodeAddress, routeMatrix } from "../_shared/maps.ts";
import { custodyDerived, planAsv, type StockCandidate } from "../_shared/asv.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- rate limiting (in-memory, per instance) ----------
const rateBuckets = new Map<string, number[]>();
function rateLimit(ip: string, limit: number): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(ip) ?? []).filter((t) => now - t < 60000);
  if (arr.length >= limit) {
    rateBuckets.set(ip, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  return true;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
function bad(msg: string, status = 400) {
  return json({ error: msg }, status);
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

async function logAudit(role: string, action: string, patientRef: string, details?: Record<string, unknown>) {
  await supabase.from("audit_log").insert({ role, action, patient_ref: patientRef, details: details ?? null });
}

// Realtime refresh broadcast — no patient data in payload.
async function broadcastRefresh(scope: string) {
  try {
    await supabase.channel("swasthya-live").send({
      type: "broadcast",
      event: "refresh",
      payload: { scope },
    });
  } catch {
    // broadcast failure should not fail the request
  }
}

// ---------- mock AI fallbacks ----------
const EMERGENCY_KEYWORDS = ["chest pain", "breathless", "unconscious", "bleeding", "snake", "saanp", "seizure", "साँप", "सांप"];
const REASON_FALLBACK: Record<string, string> = {
  "en-IN": "Emergency signs reported. Seek immediate care.",
  "hi-IN": "आपातकाल के लक्षण बताए गए। तुरंत अस्पताल जाएँ।",
};

function mockIntake(language: string, transcript: string, triageFloor: string) {
  const lower = transcript.toLowerCase();
  const isEmergency = EMERGENCY_KEYWORDS.some((k) => lower.includes(k));
  const triage = isEmergency ? "EMERGENCY" : triageFloor === "URGENT" ? "URGENT" : "ROUTINE";
  return {
    triage_level: triage,
    emergency_reason: isEmergency ? (REASON_FALLBACK[language] ?? REASON_FALLBACK["en-IN"]) : null,
    summary: {
      chief_complaint: transcript.slice(0, 120) || "(mock) symptom reported",
      duration: "(mock) not specified",
      severity: triage === "EMERGENCY" ? 9 : triage === "URGENT" ? 6 : 3,
      relevant_history: [] as string[],
    },
    source_tags: [{ claim: transcript.slice(0, 80), source: "voice" as const }],
    followup_question: isEmergency
      ? null
      : language === "hi-IN"
        ? "क्या बुखार या दर्द तेज़ है?"
        : "Is the fever or pain severe?",
    mock: true,
  };
}

const MOCK_OCR = {
  medicines: [
    { name: "Paracetamol", dosage: "650mg twice daily", ocr_confidence: 93, needs_review: false },
    { name: "Azithromycin", dosage: "500mg once daily", ocr_confidence: 72, needs_review: true },
  ],
  header: "Mock demo prescription header",
  warnings: ["Demo mode: mock OCR output, not read from your image."],
};

// ---------- helpers ----------
interface Priority { base: number }
function priorityFor(level: string): number {
  const p: Priority = { base: 20 };
  if (level === "EMERGENCY") p.base = 100;
  else if (level === "URGENT") p.base = 60;
  return p.base;
}

const ABHA_RE = /^91-\d{4}-\d{4}-\d{4}$/;

function maskAbha(abha: string): string {
  return `***${abha.slice(-4)}`;
}

function validSummary(s: unknown): { ok: boolean; error?: string } {
  const o = s as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return { ok: false, error: "summary required" };
  if (typeof o.chief_complaint !== "string" || !o.chief_complaint.trim()) return { ok: false, error: "chief_complaint required" };
  if (typeof o.duration !== "string") return { ok: false, error: "duration required" };
  const sev = Number(o.severity);
  if (!Number.isFinite(sev) || sev < 1 || sev > 10) return { ok: false, error: "severity must be 1-10" };
  if (!Array.isArray(o.relevant_history)) return { ok: false, error: "relevant_history must be an array" };
  return { ok: true };
}

function hospitalPublic(h: Record<string, unknown>) {
  return {
    id: h.id,
    name: USE_REAL_HOSPITAL_NAMES ? h.name : h.name,
    area: h.area,
    city: h.city,
    lat: h.lat,
    lng: h.lng,
    specialties: h.specialties,
    icu_beds_available: h.icu_beds_available,
    ventilators_available: h.ventilators_available,
    emergency_capable: h.emergency_capable,
    queue_length: h.queue_length,
  };
}

// ---------- emergency cascade ----------
async function runCascade(requestId: string) {
  const { data: req } = await supabase.from("emergency_requests").select("*").eq("id", requestId).maybeSingle();
  if (!req || req.status !== "BROADCASTING") return req;

  const now = new Date();
  let current = req;
  while (current.status === "BROADCASTING" && current.target_deadline_at && new Date(current.target_deadline_at) < now) {    const responded = new Set((current.responses ?? []).map((r: { hospital_id: string }) => r.hospital_id));
    if (current.current_target_hospital_id) {
      const responses = [...(current.responses ?? []), { hospital_id: current.current_target_hospital_id, action: "TIMED_OUT", at: now.toISOString() }];
      await supabase.from("emergency_requests").update({ responses }).eq("id", current.id);
      responded.add(current.current_target_hospital_id);
      current.responses = responses;
    }
    const { data: candidates } = await supabase
      .from("hospitals")
      .select("id, name, address, lat, lng")
      .eq("emergency_capable", true);
    const next = (candidates ?? [])
      .filter((c: { id: string }) => !responded.has(c.id))
      .sort((a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
        const dl = current.lat != null && current.lng != null;
        const da = dl ? Math.hypot(a.lat - current.lat, a.lng - current.lng) : 0;
        const db = dl ? Math.hypot(b.lat - current.lat, b.lng - current.lng) : 0;
        return da - db;
      })[0];
    if (!next) {
      const { data: updated } = await supabase
        .from("emergency_requests")
        .update({ status: "DECLINED_ALL" })
        .eq("id", current.id)
        .select()
        .single();
      current = updated ?? current;
      break;
    }
    const { data: updated } = await supabase
      .from("emergency_requests")
      .update({
        current_target_hospital_id: next.id,
        target_deadline_at: new Date(Date.now() + EMERGENCY_WINDOW_SEC * 1000).toISOString(),
      })
      .eq("id", current.id)
      .select()
      .single();
    current = updated ?? current;
    await broadcastRefresh("emergency");
  }
  return current;
}

// Lazy cascade for all live emergency requests (called from admin overview poll).
async function runCascadeAll() {
  const { data: live } = await supabase
    .from("emergency_requests")
    .select("id")
    .eq("status", "BROADCASTING")
    .lt("target_deadline_at", new Date().toISOString())
    .limit(20);
  for (const r of live ?? []) {
    await runCascade(r.id);
  }
  if (live?.length) await broadcastRefresh("emergency");
}

// ---------- intake AI ----------
async function handleIntake(body: Record<string, unknown>, emergencyOnly: boolean) {
  const language: string = body.language ?? "en-IN";
  const transcript: string = body.transcript ?? "";
  const triageFloor: string = emergencyOnly ? "ROUTINE" : body.triage_floor === "URGENT" ? "URGENT" : "ROUTINE";
  const prior = body.prior_history;
  const answers = body.followup_answers;

  const langName: Record<string, string> = {
    "en-IN": "English (India)", "hi-IN": "Hindi (Devanagari)", "ta-IN": "Tamil", "bn-IN": "Bengali", "mr-IN": "Marathi", "te-IN": "Telugu",
  };
  const prompt = `You are a hospital triage intake assistant for a hackathon prototype. Patient speaks ${langName[language] ?? language}.
Transcript: """${transcript}"""
${answers ? `Follow-up answers so far: ${JSON.stringify(answers)}` : ""}
${prior ? `Prior records (DEMO DATA): ${JSON.stringify(prior)}` : ""}
Rules:
- Respond ENTIRELY in ${langName[language] ?? language} for patient-facing strings. JSON keys in English.
- triage_level: ROUTINE, URGENT or EMERGENCY. ${triageFloor === "URGENT" ? "triage_level must be at least URGENT (never ROUTINE)." : ""} Use EMERGENCY for chest pain, breathlessness, unconsciousness, heavy bleeding, snake bite, stroke signs.
- If triage_level is EMERGENCY, emergency_reason must be a non-empty string. Otherwise null.
- summary: {chief_complaint, duration, severity (1-10 integer), relevant_history (string[])}.
- source_tags: [{claim, source}] where source is "voice", "history" or "ocr".
- followup_question: exactly ONE short question in ${langName[language] ?? language} (string), or null if enough information.
- NOT a diagnosis; structured intake only. Return JSON only.
${emergencyOnly ? "This is an EMERGENCY summary request from a family member: triage_level must be EMERGENCY and followup_question must be null." : ""}`;

  let result: Record<string, unknown> | null = null;
  try {
    result = await geminiJson(prompt);
  } catch (e) {
    return json({ error: `AI service error: ${(e as Error).message}`, mock: false }, 502);
  }
  if (!result) return json({ ...mockIntake(language, transcript, triageFloor), mock: true });

  // Normalize + enforce floor and emergency reason
  const level = String(result.triage_level ?? "ROUTINE");
  let normalized = ["ROUTINE", "URGENT", "EMERGENCY"].includes(level) ? level : "ROUTINE";
  if (triageFloor === "URGENT" && normalized === "ROUTINE") normalized = "URGENT";
  if (emergencyOnly) normalized = "EMERGENCY";
  const summary = (result.summary as Record<string, unknown> | undefined) ?? {};
  if (!Number.isFinite(Number(summary.severity))) summary.severity = 5;
  summary.chief_complaint = String(summary.chief_complaint ?? "—");
  summary.duration = String(summary.duration ?? "—");
  const reason = normalized === "EMERGENCY"
    ? (typeof result.emergency_reason === "string" && result.emergency_reason.trim()
        ? result.emergency_reason
        : (REASON_FALLBACK[language] ?? REASON_FALLBACK["en-IN"]))
    : null;
  let question = typeof result.followup_question === "string" ? result.followup_question : null;
  if (normalized === "EMERGENCY") question = null;
  return json({
    triage_level: normalized,
    emergency_reason: reason,
    summary,
    source_tags: Array.isArray(result.source_tags) ? result.source_tags : [],
    followup_question: question,
    mock: false,
  });
}

// ---------- ASV handlers ----------
async function loadStockCandidates(): Promise<StockCandidate[]> {
  const { data } = await supabase
    .from("asv_stock")
    .select("*, hospitals(name, city, lat, lng, raw)")
    .gt("quantity", 0);
  return (data ?? []).map((row: Record<string, unknown>) => {
    const h = row.hospitals as Record<string, unknown> | null;
    const raw = (h?.raw as { capabilities?: { toxicology?: string } } | null) ?? {};
    return {
      batch_id: row.id as string,
      hospital_id: row.hospital_id as string,
      hospital_name: (h?.name as string) ?? "",
      city: (h?.city as string) ?? "",
      lat: (h?.lat as number) ?? 0,
      lng: (h?.lng as number) ?? 0,
      batch_code: row.batch_code as string,
      quantity: row.quantity as number,
      expiry_date: row.expiry_date as string,
      updated_at: row.updated_at as string,
      toxicology_24x7: raw.capabilities?.toxicology === "24x7",
    };
  });
}

// ---------- router ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: CORS_HEADERS });
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/api/, "") || "/";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // ---------- AI (rate-limited) ----------
    if (path === "/intake") {
      if (!rateLimit(clientIp(req), 20)) return bad("Rate limit exceeded", 429);
      return await handleIntake(body, false);
    }
    if (path === "/emergency-summary") {
      if (!rateLimit(clientIp(req), 20)) return bad("Rate limit exceeded", 429);
      return await handleIntake(body, true);
    }
    if (path === "/ocr") {
      if (!rateLimit(clientIp(req), 10)) return bad("Rate limit exceeded", 429);
      const { imageBase64, mime } = body;
      if (!imageBase64) return bad("imageBase64 required");
      const prompt = `Read this prescription image (OCR). Return JSON {"medicines":[{"name","dosage","ocr_confidence" 0-100,"needs_review"}],"header","warnings"}. needs_review = confidence < 85. Do not invent medicines; lower confidence instead.`;
      let result: Record<string, unknown> | null = null;
      try {
        result = await geminiJson(prompt, { base64: imageBase64, mime: mime ?? "image/jpeg" });
      } catch (e) {
        return json({ error: `AI service error: ${(e as Error).message}`, mock: false }, 502);
      }
      if (!result) return json({ ...MOCK_OCR, mock: true });
      const meds = (result.medicines as { ocr_confidence: number; needs_review?: boolean }[] | undefined) ?? [];
      result.medicines = meds.map((m) => ({ ...m, needs_review: (m.ocr_confidence ?? 0) < 85 }));
      return json({ ...result, mock: false });
    }

    // ---------- public ----------
    if (path === "/patient/lookup") {
      const abha: string = body.abha_id ?? "";
      if (!ABHA_RE.test(abha)) return bad("Invalid ABHA format (91-XXXX-XXXX-XXXX)");
      const { data, error } = await supabase
        .from("patients")
        .select("name, conditions, medicines, past_visits, ocr_prescriptions")
        .eq("abha_id", abha)
        .maybeSingle();
      if (error) return bad(error.message, 500);
      await logAudit("PATIENT", "VIEW_RECORDS", maskAbha(abha));
      return json({ patient: data ?? null });
    }

    if (path === "/hospitals/list") {
      const { data, error } = await supabase.from("hospitals").select("*");
      if (error) return bad(error.message, 500);
      return json({ hospitals: (data ?? []).map(hospitalPublic) });
    }

    if (path === "/queue/submit") {
      const { language, abha_id, hospital_id, triage_floor, transcript, followup_answers, intake, prior_history, ocr_records, phone } = body;
      if (triage_floor !== "ROUTINE" && triage_floor !== "URGENT") return bad("triage_floor must be ROUTINE or URGENT");
      if (abha_id && !ABHA_RE.test(abha_id)) return bad("Invalid ABHA format");
      if (phone && !/^(\+91)?\d{10}$/.test(phone.replace(/\s/g, ""))) return bad("Invalid phone");
      const intakeObj = (intake ?? {}) as Record<string, unknown>;
      const summaryObj = (intakeObj.summary ?? intakeObj) as Record<string, unknown>;
      const v = validSummary(summaryObj);
      if (!v.ok) return bad(v.error!);
      const level = String(intakeObj.triage_level ?? triage_floor ?? "ROUTINE");
      const { data: entry, error: e } = await supabase
        .from("queue_entries")
        .insert({
          patient_label: abha_id ? maskAbha(abha_id) : "New patient",
          abha_id: abha_id ?? null,
          phone: phone ?? null,
          language: language ?? "en-IN",
          transcript: transcript ?? "",
          followup_answers: followup_answers ?? [],
          triage_level: priorityFor(level) === 100 ? "EMERGENCY" : level,
          triage_floor,
          summary: summaryObj,
          source_tags: (intakeObj.source_tags ?? []) as unknown as object,
          prior_history: prior_history ?? null,
          ocr_records: ocr_records ?? [],
          hospital_id,
          priority_score: priorityFor(level),
          status: "SENT_TO_DOCTOR",
        })
        .select()
        .single();
      if (e) return bad(e.message, 500);
      const { count } = await supabase.from("queue_entries").select("*", { count: "exact", head: true }).eq("hospital_id", hospital_id);
      await broadcastRefresh("queue");
      return json({
        token: entry.token,
        entry_id: entry.id,
        position: count ?? 1,
        estimated_wait_minutes: (count ?? 1) * 8,
      });
    }

    if (path === "/queue/status") {
      const { entry_id } = body;
      const { data: entry } = await supabase.from("queue_entries").select("id, token, triage_level, priority_score, manual_rank, created_at").eq("id", entry_id).maybeSingle();
      if (!entry) return bad("Entry not found", 404);
      const { count } = await supabase.from("queue_entries").select("*", { count: "exact", head: true }).eq("hospital_id", (await supabase.from("queue_entries").select("hospital_id").eq("id", entry_id).maybeSingle()).data?.hospital_id);
      return json({
        token: entry.token,
        position: count ?? 1,
        total: count ?? 1,
        estimated_wait_minutes: (count ?? 1) * 8,
        triage_level: entry.triage_level,
      });
    }

    if (path === "/emergency/create") {
      const { kind, lat, lng, abha_id, language } = body;
      if (!["AMBULANCE", "ABHA_FAMILY"].includes(kind)) return bad("kind must be AMBULANCE or ABHA_FAMILY");
      const { data: candidates } = await supabase.from("hospitals").select("id, name, address, lat, lng").eq("emergency_capable", true);
      if (!candidates?.length) return bad("No emergency-capable hospitals configured", 500);
      const ordered = [...candidates].sort((a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
        if (lat == null || lng == null) return 0;
        return Math.hypot(a.lat - lat, a.lng - lng) - Math.hypot(b.lat - lat, b.lng - lng);
      });
      const { data: reqRow, error: e } = await supabase
        .from("emergency_requests")
        .insert({
          kind,
          patient_label: kind === "AMBULANCE" ? "Ambulance caller" : "Family-reported",
          abha_id: abha_id ?? null,
          lat: lat ?? null,
          lng: lng ?? null,
          language: language ?? "en-IN",
          status: kind === "AMBULANCE" ? "BROADCASTING" : "BROADCASTING",
          current_target_hospital_id: ordered[0].id,
          target_deadline_at: new Date(Date.now() + EMERGENCY_WINDOW_SEC * 1000).toISOString(),
        })
        .select()
        .single();
      if (e) return bad(e.message, 500);
      await broadcastRefresh("emergency");
      const distances = await routeMatrix(
        { lat: lat ?? ordered[0].lat, lng: lng ?? ordered[0].lng },
        ordered.slice(0, 3).map((h: { lat: number; lng: number }) => h),
      );
      return json({
        request_id: reqRow.id,
        candidates: ordered.slice(0, 3).map((h: { id: string; name: string; address: string }, i: number) => ({
          id: h.id,
          name: h.name,
          address: h.address,
          distance_km: Math.round(distances[i].km * 10) / 10,
          estimated: distances[i].estimated,
        })),
      });
    }

    if (path === "/emergency/answers") {
      const { request_id, answers, free_text, language } = body;
      const { data: reqRow } = await supabase.from("emergency_requests").select("*").eq("id", request_id).maybeSingle();
      if (!reqRow) return bad("Not found", 404);
      if (reqRow.kind !== "ABHA_FAMILY") return bad("Only family-reported requests accept answers");
      const transcript = [free_text, ...(answers ?? []).map((a: { question: string; answer: string }) => `${a.question}: ${a.answer}`)].filter(Boolean).join(". ");
      const ai = await handleIntake({ language: language ?? reqRow.language, transcript }, true);
      const aiBody = await ai.json();
      const { error: e } = await supabase
        .from("emergency_requests")
        .update({ answers: answers ?? [], emergency_summary: aiBody, status: "BROADCASTING", target_deadline_at: new Date(Date.now() + EMERGENCY_WINDOW_SEC * 1000).toISOString() })
        .eq("id", request_id);
      if (e) return bad(e.message, 500);
      await broadcastRefresh("emergency");
      return json({ ok: true, summary: aiBody });
    }

    if (path === "/emergency/status") {
      const { request_id } = body;
      await runCascade(request_id);
      const { data: reqRow } = await supabase.from("emergency_requests").select("*").eq("id", request_id).maybeSingle();
      if (!reqRow) return bad("Not found", 404);
      let target = null;
      let accepted = null;
      if (reqRow.current_target_hospital_id) {
        const { data } = await supabase.from("hospitals").select("name, address").eq("id", reqRow.current_target_hospital_id).maybeSingle();
        target = data;
      }
      if (reqRow.accepted_hospital_id) {
        const { data } = await supabase.from("hospitals").select("name, address").eq("id", reqRow.accepted_hospital_id).maybeSingle();
        accepted = data;
      }
      return json({
        status: reqRow.status,
        target_name: target?.name ?? null,
        target_address: target?.address ?? null,
        deadline_at: reqRow.target_deadline_at,
        accepted_name: accepted?.name ?? null,
        accepted_address: accepted?.address ?? null,
      });
    }

    if (path === "/emergency/retry") {
      const { request_id } = body;
      const { data: candidates } = await supabase.from("hospitals").select("id, lat, lng").eq("emergency_capable", true);
      const { data: reqRow } = await supabase.from("emergency_requests").select("lat, lng").eq("id", request_id).maybeSingle();
      if (!reqRow) return bad("Not found", 404);
      const ordered = [...(candidates ?? [])].sort((a) => Math.hypot(a.lat - (reqRow.lat ?? a.lat), a.lng - (reqRow.lng ?? a.lng)));
      const { error: e } = await supabase
        .from("emergency_requests")
        .update({
          status: "BROADCASTING",
          responses: [],
          current_target_hospital_id: ordered[0]?.id ?? null,
          target_deadline_at: new Date(Date.now() + EMERGENCY_WINDOW_SEC * 1000).toISOString(),
        })
        .eq("id", request_id);
      if (e) return bad(e.message, 500);
      await broadcastRefresh("emergency");
      return json({ ok: true });
    }

    // ---------- staff ----------
    if (path === "/staff/login") {
      const { username, password } = body;
      const { data: user } = await supabase
        .from("staff_users")
        .select("id, username, role, display_name, hospital_id, password_hash")
        .eq("username", username)
        .maybeSingle();
      if (!user) return bad("Invalid credentials", 401);
      const hash = await hashPassword(password ?? "");
      if (hash !== user.password_hash) return bad("Invalid credentials", 401);
      await logAudit(user.role, "STAFF_LOGIN", user.id);
      const token = await signToken({ sub: user.id, role: user.role as StaffRole, hospital_id: user.hospital_id, display_name: user.display_name });
      return json({ token, user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name, hospital_id: user.hospital_id } });
    }

    if (path === "/staff/queue") {
      const claims = await requireRole(req, ["DOCTOR", "RECEPTION", "ADMIN"]);
      const { data, error } = await supabase.from("queue_entries").select("*");
      if (error) return bad(error.message, 500);
      const sorted = [...(data ?? [])].sort((a, b) => {
        if (a.manual_rank != null && b.manual_rank != null) return a.manual_rank - b.manual_rank;
        if (a.manual_rank != null) return -1;
        if (b.manual_rank != null) return 1;
        const pa = priorityFor(a.triage_level) + Math.min(20, (Date.now() - new Date(a.created_at).getTime()) / 120000);
        const pb = priorityFor(b.triage_level) + Math.min(20, (Date.now() - new Date(b.created_at).getTime()) / 120000);
        return pb - pa;
      }).map((e, i) => ({ ...e, position: i + 1 }));
      let filtered = sorted;
      if (claims.role === "RECEPTION") {
        filtered = sorted.map((e) => ({ id: e.id, token: e.token, status: e.status, position: e.position, manual_rank: e.manual_rank, triage_level: e.triage_level }));
      } else if (claims.role === "ADMIN") {
        filtered = sorted.map((e) => ({ id: e.id, token: e.token, status: e.status, triage_level: e.triage_level }));
      }
      return json({ queue: filtered });
    }

    if (path === "/staff/entry") {
      await requireRole(req, ["DOCTOR"]);
      const { data: entry } = await supabase.from("queue_entries").select("*").eq("id", body.id).maybeSingle();
      if (!entry) return bad("Not found", 404);
      await logAudit("DOCTOR", "VIEW_ENTRY", entry.id);
      return json({ entry });
    }

    if (path === "/staff/approve") {
      await requireRole(req, ["DOCTOR"]);
      const summary = body.summary;
      const v = validSummary(summary);
      if (!v.ok) return bad(v.error!);
      const { error } = await supabase
        .from("queue_entries")
        .update({ approved_by: claims.display_name, approved_at: new Date().toISOString(), approved_summary: summary, status: "APPROVED" })
        .eq("id", body.id);
      if (error) return bad(error.message, 500);
      await logAudit("DOCTOR", "APPROVE", body.id);
      await broadcastRefresh("queue");
      return json({ ok: true, approved_by: claims.display_name, approved_at: new Date().toISOString() });
    }

    if (path === "/staff/override") {
      await requireRole(req, ["DOCTOR"]);
      const level = body.triage_level;
      if (!["ROUTINE", "URGENT", "EMERGENCY"].includes(level)) return bad("Invalid triage level");
      const { data: before } = await supabase.from("queue_entries").select("triage_level").eq("id", body.id).maybeSingle();
      const { error } = await supabase
        .from("queue_entries")
        .update({ triage_level: level, priority_score: priorityFor(level) })
        .eq("id", body.id);
      if (error) return bad(error.message, 500);
      await logAudit("DOCTOR", "OVERRIDE_PRIORITY", body.id, { from: before?.triage_level, to: level });
      await broadcastRefresh("queue");
      return json({ ok: true });
    }

    if (path === "/staff/reorder") {
      await requireRole(req, ["RECEPTION"]);
      const order: string[] = body.order ?? [];
      for (const [i, id] of order.entries()) {
        await supabase.from("queue_entries").update({ manual_rank: i }).eq("id", id);
      }
      await logAudit("RECEPTION", "REORDER_QUEUE", "", { order });
      await broadcastRefresh("queue");
      return json({ ok: true });
    }

    if (path === "/staff/ocr") {
      await requireRole(req, ["DOCTOR"]);
      const { id, imageBase64, mime } = body;
      const prompt = `Read this prescription image (OCR). Return JSON {"medicines":[{"name","dosage","ocr_confidence" 0-100,"needs_review"}],"header","warnings"}. needs_review = confidence < 85.`;
      let result: Record<string, unknown> | null = null;
      try {
        result = await geminiJson(prompt, { base64: imageBase64, mime: mime ?? "image/jpeg" });
      } catch (e) {
        return json({ error: `AI service error: ${(e as Error).message}` }, 502);
      }
      if (!result) result = structuredClone(MOCK_OCR);
      const record = { file: "doctor_upload.jpg", date: new Date().toISOString().slice(0, 10), ...(result as object) };
      const { data: entry } = await supabase.from("queue_entries").select("ocr_records").eq("id", id).maybeSingle();
      if (!entry) return bad("Not found", 404);
      const records = [...(entry.ocr_records ?? []), record];
      await supabase.from("queue_entries").update({ ocr_records: records }).eq("id", id);
      await logAudit("DOCTOR", "OCR_UPLOAD", id);
      await broadcastRefresh("queue");
      return json({ ok: true, record });
    }

    if (path === "/emergency/respond") {
      const claims = await requireRole(req, ["ADMIN"]);
      if (!claims.hospital_id) return bad("Admin has no hospital linked", 403);
      const { request_id, action, reason } = body;
      const { data: reqRow } = await supabase.from("emergency_requests").select("*").eq("id", request_id).maybeSingle();
      if (!reqRow) return bad("Not found", 404);
      await runCascade(request_id);      const { data: fresh } = await supabase.from("emergency_requests").select("status, current_target_hospital_id, responses").eq("id", request_id).maybeSingle();
      if (!fresh || fresh.status !== "BROADCASTING") return bad("Request already resolved", 409);
      if (fresh.current_target_hospital_id !== claims.hospital_id) return bad("Your hospital is not the current target", 403);
      if (action === "ACCEPT") {
        const { data: hospital } = await supabase.from("hospitals").select("name").eq("id", claims.hospital_id).maybeSingle();
        const responses = [...(fresh.responses ?? []), { hospital_id: claims.hospital_id, action: "ACCEPT", at: new Date().toISOString() }];
        const { error: e } = await supabase
          .from("emergency_requests")
          .update({ status: "ACCEPTED", accepted_hospital_id: claims.hospital_id, responses })
          .eq("id", request_id)
          .eq("status", "BROADCASTING")
          .eq("current_target_hospital_id", claims.hospital_id);
        if (e) return bad(e.message, 500);
        await logAudit("ADMIN", "EMERGENCY_ACCEPT", request_id, { hospital: hospital?.name });
        await broadcastRefresh("emergency");
        return json({ ok: true, status: "ACCEPTED" });
      }
      if (action === "DECLINE") {
        const responses = [...(fresh.responses ?? []), { hospital_id: claims.hospital_id, action: "DECLINE", reason, at: new Date().toISOString() }];
        await supabase.from("emergency_requests").update({ responses }).eq("id", request_id);
        await logAudit("ADMIN", "EMERGENCY_DECLINE", request_id, { reason });
        await runCascade(request_id);
        await broadcastRefresh("emergency");
        return json({ ok: true, status: "BROADCASTING" });
      }
      return bad("action must be ACCEPT or DECLINE");
    }

    if (path === "/staff/admin/capacity") {
      const claims = await requireRole(req, ["ADMIN"]);
      if (!claims.hospital_id) return bad("Admin has no hospital linked", 403);
      const { field, delta } = body;
      if (!["icu_beds_available", "ventilators_available"].includes(field)) return bad("Invalid field");
      const { data: h } = await supabase.from("hospitals").select(field).eq("id", claims.hospital_id).maybeSingle();
      if (!h) return bad("Hospital not found", 404);
      const next = Math.max(0, (h[field] as number) + (Number(delta) || 0));
      await supabase.from("hospitals").update({ [field]: next }).eq("id", claims.hospital_id);
      await logAudit("ADMIN", "CAPACITY_CHANGE", claims.hospital_id, { field, delta, new_value: next });
      await broadcastRefresh("queue");
      return json({ ok: true, value: next });
    }

    if (path === "/staff/admin/overview") {
      const claims = await requireRole(req, ["ADMIN"]);
      if (!claims.hospital_id) return bad("Admin has no hospital linked", 403);
      await runCascadeAll();
      const { data: hospital } = await supabase
        .from("hospitals")
        .select("id, name, city, area, icu_beds_available, ventilators_available, emergency_capable, queue_length, specialties, lat, lng, raw")
        .eq("id", claims.hospital_id)
        .maybeSingle();
      const { data: reqs } = await supabase
        .from("emergency_requests")
        .select("id, kind, status, current_target_hospital_id, target_deadline_at, accepted_hospital_id, emergency_summary, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      const { data: legs } = await supabase
        .from("transfer_legs")
        .select("*, transfer_requests(patient_ref, vials_needed, status)")
        .eq("source_hospital_id", claims.hospital_id)
        .order("created_at", { ascending: false })
        .limit(20);
      const mine = (reqs ?? []).filter((r) => r.current_target_hospital_id === claims.hospital_id || r.accepted_hospital_id === claims.hospital_id);
      const others = (reqs ?? []).filter((r) => r.current_target_hospital_id !== claims.hospital_id && r.accepted_hospital_id !== claims.hospital_id);
      const h = hospital ?? {};
      const raw = (h.raw as { specialists_on_duty?: string[]; blood_stock?: Record<string, number> } | null) ?? {};
      return json({
        hospital: {
          id: h.id,
          name: h.name,
          city: h.city,
          area: h.area,
          icu_beds_available: h.icu_beds_available ?? 0,
          ventilators_available: h.ventilators_available ?? 0,
          queue_length: h.queue_length ?? 0,
          specialists_on_duty: raw.specialists_on_duty ?? [],
          blood_stock: raw.blood_stock ?? {},
        },
        my_emergencies: mine,
        other_emergencies_count: others.length,
        legs: legs ?? [],
      });
    }

    if (path === "/staff/audit") {
      await requireRole(req, ["DOCTOR", "ADMIN"]);
      const { data } = await supabase.from("audit_log").select("*").order("ts", { ascending: false }).limit(50);
      return json({ log: data ?? [] });
    }

    // ---------- ASV ----------
    if (path === "/asv/plan") {
      const claims = await requireRole(req, ["DOCTOR"]);
      const { origin_lat, origin_lng, vials_needed, patient_stable, patient_ref, origin_city } = body;
      const vials = Number(vials_needed);
      if (!Number.isFinite(vials) || vials < 1 || vials > 200) return bad("vials_needed must be 1-200");
      const stocks = await loadStockCandidates();
      const plan = await planAsv(
        { lat: origin_lat, lng: origin_lng, city: origin_city },
        stocks,
        vials,
        Boolean(patient_stable),
        null,
      );
      // Create transfer_request in PLANNING
      const { data: tr, error: e } = await supabase
        .from("transfer_requests")
        .insert({
          patient_ref: patient_ref ?? "WALKIN",
          vials_needed: vials,
          decided_by_doctor: claims.display_name,
          status: "PLANNING",
          move_mode: plan.move_mode,
          plan: plan as unknown as object,
        })
        .select()
        .single();
      if (e) return bad(e.message, 500);
      await logAudit("DOCTOR", "ASV_PLAN", tr.id, { vials, status: plan.status });
      return json({ transfer_request_id: tr.id, plan });
    }

    if (path === "/asv/request") {
      const claims = await requireRole(req, ["DOCTOR"]);
      const { transfer_request_id } = body;
      const { data: tr } = await supabase.from("transfer_requests").select("*").eq("id", transfer_request_id).maybeSingle();
      if (!tr) return bad("Not found", 404);
      if (tr.status !== "PLANNING") return bad("Request already sent", 409);
      const plan = tr.plan as { sources?: { batch_id: string; hospital_id: string; vials: number }[] };
      const sources = plan?.sources ?? [];
      if (!sources.length) return bad("No planned sources to request");
      const deadline = new Date(Date.now() + LEG_WINDOW_MIN * 60000).toISOString();
      for (const s of sources) {
        const { data: leg } = await supabase
          .from("transfer_legs")
          .insert({
            request_id: transfer_request_id,
            source_hospital_id: s.hospital_id,
            batch_id: s.batch_id,
            vials: s.vials,
            status: "REQUESTED",
            deadline_at: deadline,
            sequence_no: 1,
          })
          .select()
          .single();
        await supabase.from("custody_events").insert({ leg_id: leg.id, event: "REQUESTED", location_name: "Requesting hospital", actor: claims.display_name, details: { vials: s.vials } });
      }
      await supabase.from("transfer_requests").update({ status: "REQUESTED" }).eq("id", transfer_request_id);
      await logAudit("DOCTOR", "ASV_REQUEST", transfer_request_id, { legs: sources.length });
      await broadcastRefresh("asv");
      return json({ ok: true, legs: sources.length, deadline_at: deadline });
    }

    if (path === "/asv/respond") {
      const claims = await requireRole(req, ["ADMIN"]);
      if (!claims.hospital_id) return bad("Admin has no hospital linked", 403);
      const { leg_id, action, reason } = body;
      const { data: leg } = await supabase.from("transfer_legs").select("*, transfer_requests(vials_needed, requesting_hospital_id)").eq("id", leg_id).maybeSingle();
      if (!leg) return bad("Not found", 404);
      if (leg.source_hospital_id !== claims.hospital_id) return bad("Not your hospital's leg", 403);
      if (leg.status !== "REQUESTED") return bad(`Leg is ${leg.status}, not REQUESTED`, 409);
      if (action === "ACCEPT") {
        // Atomic conditional update + stock decrement
        const { data: batch, error: be } = await supabase
          .from("asv_stock")
          .update({ quantity: (await supabase.from("asv_stock").select("quantity").eq("id", leg.batch_id).maybeSingle()).data!.quantity - leg.vials })
          .eq("id", leg.batch_id)
          .gt("quantity", leg.vials - 1)
          .select()
          .single();
        if (be || !batch) return bad("Insufficient stock or batch changed", 409);
        const { error: e } = await supabase
          .from("transfer_legs")
          .update({ status: "ACCEPTED" })
          .eq("id", leg_id)
          .eq("status", "REQUESTED");
        if (e) return bad(e.message, 500);
        const { data: hospital } = await supabase.from("hospitals").select("name").eq("id", claims.hospital_id).maybeSingle();
        await supabase.from("custody_events").insert({ leg_id, event: "ACCEPTED", location_name: hospital?.name ?? "Source hospital", actor: claims.display_name, details: { batch: leg.batch_id } });
        await logAudit("ADMIN", "ASV_LEG_ACCEPT", leg_id);
        await broadcastRefresh("asv");
        return json({ ok: true, status: "ACCEPTED" });
      }
      if (action === "DECLINE") {
        await supabase.from("transfer_legs").update({ status: "DECLINED", decline_reason: reason ?? "No reason given" }).eq("id", leg_id).eq("status", "REQUESTED");
        const { data: hospital } = await supabase.from("hospitals").select("name").eq("id", claims.hospital_id).maybeSingle();
        await supabase.from("custody_events").insert({ leg_id, event: "DECLINED", location_name: hospital?.name ?? "Source hospital", actor: claims.display_name, details: { reason } });
        await logAudit("ADMIN", "ASV_LEG_DECLINE", leg_id, { reason });
        await broadcastRefresh("asv");
        return json({ ok: true, status: "DECLINED" });
      }
      return bad("action must be ACCEPT or DECLINE");
    }

    if (path === "/asv/timeouts") {
      await requireRole(req, ["DOCTOR", "ADMIN"]);
      const { data: overdue } = await supabase.from("transfer_legs").select("*").eq("status", "REQUESTED").lt("deadline_at", new Date().toISOString());
      for (const leg of overdue ?? []) {
        await supabase.from("transfer_legs").update({ status: "TIMED_OUT" }).eq("id", leg.id).eq("status", "REQUESTED");
        await supabase.from("custody_events").insert({ leg_id: leg.id, event: "TIMED_OUT", location_name: "Source hospital", actor: "system", details: { sequence_no: leg.sequence_no } });
      }
      await broadcastRefresh("asv");
      return json({ ok: true, timed_out: overdue?.length ?? 0 });
    }

    if (path === "/asv/dispatch") {
      const claims = await requireRole(req, ["ADMIN"]);
      if (!claims.hospital_id) return bad("Admin has no hospital linked", 403);
      const { leg_id, courier } = body;
      const { data: leg } = await supabase.from("transfer_legs").select("*").eq("id", leg_id).maybeSingle();
      if (!leg) return bad("Not found", 404);
      if (leg.source_hospital_id !== claims.hospital_id) return bad("Not your hospital's leg", 403);
      if (leg.status !== "ACCEPTED") return bad("Leg must be ACCEPTED to dispatch", 409);
      const { data: hospital } = await supabase.from("hospitals").select("name").eq("id", claims.hospital_id).maybeSingle();
      await supabase.from("transfer_legs").update({ status: "DISPATCHED" }).eq("id", leg_id).eq("status", "ACCEPTED");
      await supabase.from("custody_events").insert({ leg_id, event: "DISPATCHED", location_name: hospital?.name ?? "Source hospital", actor: courier ?? claims.display_name });
      await logAudit("ADMIN", "ASV_DISPATCH", leg_id, { courier });
      await broadcastRefresh("asv");
      return json({ ok: true });
    }

    if (path === "/asv/handover") {
      const claims = await requireRole(req, ["ADMIN", "RECEPTION"]);
      const { leg_id, location_name, actor } = body;
      const { data: leg } = await supabase.from("transfer_legs").select("*").eq("id", leg_id).maybeSingle();
      if (!leg) return bad("Not found", 404);
      await supabase.from("custody_events").insert({ leg_id, event: "HANDOVER", location_name: location_name ?? "Relay point", actor: actor ?? claims.display_name });
      await logAudit(claims.role, "ASV_HANDOVER", leg_id, { location_name });
      await broadcastRefresh("asv");
      return json({ ok: true });
    }

    if (path === "/asv/receive") {
      const claims = await requireRole(req, ["DOCTOR", "ADMIN"]);
      const { leg_id, actor } = body;
      const { data: leg } = await supabase.from("transfer_legs").select("*, transfer_requests(vials_needed, requesting_hospital_id, id)").eq("id", leg_id).maybeSingle();
      if (!leg) return bad("Not found", 404);
      if (leg.status !== "DISPATCHED") return bad("Leg must be DISPATCHED to receive", 409);
      await supabase.from("transfer_legs").update({ status: "RECEIVED" }).eq("id", leg_id).eq("status", "DISPATCHED");
      const { data: tr } = await supabase.from("transfer_requests").select("requesting_hospital_id").eq("id", leg.request_id).maybeSingle();
      if (tr && tr.requesting_hospital_id !== claims.hospital_id && claims.role !== "ADMIN") return bad("Not your hospital", 403);
      const { data: hospital } = await supabase.from("hospitals").select("name").eq("id", tr?.requesting_hospital_id ?? claims.hospital_id).maybeSingle();
      await supabase.from("custody_events").insert({ leg_id, event: "RECEIVED", location_name: hospital?.name ?? "Requesting hospital", actor: actor ?? claims.display_name });
      // Close the request if received vials >= needed
      const { data: legs } = await supabase.from("transfer_legs").select("vials, status").eq("request_id", leg.request_id).eq("status", "RECEIVED");
      const received = (legs ?? []).reduce((s: number, l: { vials: number }) => s + l.vials, 0);
      const { data: trFull } = await supabase.from("transfer_requests").select("vials_needed").eq("id", leg.request_id).maybeSingle();
      if (trFull && received >= trFull.vials_needed) {
        await supabase.from("transfer_requests").update({ status: "CLOSED" }).eq("id", leg.request_id);
      } else {
        await supabase.from("transfer_requests").update({ status: "PARTIAL" }).eq("id", leg.request_id).eq("status", "REQUESTED");
      }
      await logAudit(claims.role, "ASV_RECEIVE", leg_id, { received, needed: trFull?.vials_needed });
      await broadcastRefresh("asv");
      return json({ ok: true, received, needed: trFull?.vials_needed });
    }

    if (path === "/asv/status") {
      await requireRole(req, ["DOCTOR", "ADMIN"]);
      const { transfer_request_id } = body;
      const { data: tr } = await supabase.from("transfer_requests").select("*").eq("id", transfer_request_id).maybeSingle();
      if (!tr) return bad("Not found", 404);
      const { data: legs } = await supabase.from("transfer_legs").select("*").eq("request_id", transfer_request_id).order("created_at");
      const legIds = (legs ?? []).map((l: { id: string }) => l.id);
      const { data: events } = await supabase.from("custody_events").select("*").in("leg_id", legIds.length ? legIds : ["00000000-0000-0000-0000-000000000000"]).order("at");
      const custody = custodyDerived((events ?? []).map((e: { event: string; at: string; location_name: string }) => ({ event: e.event, at: e.at, location_name: e.location_name })));
      return json({
        request: tr,
        legs: legs ?? [],
        custody_events: events ?? [],
        current_location: custody.currentLocation,
        transit_minutes: custody.transitMinutes,
        cold_chain_ok: custody.cold_chain_ok,
        warnings: [
          ...(custody.cold_chain_ok === false ? ["Cold chain warning: transit exceeded 120 minutes"] : []),
        ],
      });
    }

    if (path === "/asv/stock") {
      const claims = await requireRole(req, ["ADMIN"]);
      if (!claims.hospital_id) return bad("Admin has no hospital linked", 403);
      const { batch_code, quantity, expiry_date } = body;
      if (!batch_code) return bad("batch_code required");
      const qty = Number(quantity);
      if (!Number.isFinite(qty) || qty < 0) return bad("quantity must be >= 0");
      if (!expiry_date || new Date(expiry_date) < new Date(new Date().toDateString())) return bad("Expiry date must be in the future");
      const { error: e } = await supabase
        .from("asv_stock")
        .upsert(
          { hospital_id: claims.hospital_id, batch_code, quantity: qty, expiry_date, updated_at: new Date().toISOString(), updated_by: claims.display_name },
          { onConflict: "hospital_id,batch_code" },
        );
      if (e) return bad(e.message, 500);
      await logAudit("ADMIN", "ASV_STOCK_UPDATE", claims.hospital_id, { batch_code, quantity: qty });
      await broadcastRefresh("asv");
      return json({ ok: true });
    }

    // ---------- maps ----------
    if (path === "/maps/geocode") {
      const { query } = body;
      if (!query) return bad("query required");
      const result = await geocodeAddress(query);
      return json({ result });
    }

    return bad("Not found", 404);
  } catch (err) {
    if (err instanceof AuthError) return bad(err.message, err.status);
    return json({ error: (err as Error).message ?? "Server error" }, 500);
  }
});
