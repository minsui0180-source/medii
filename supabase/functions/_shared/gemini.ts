// Gemini JSON helper. Key goes in the x-goog-api-key header, never the URL.

import { MODEL } from "./config.ts";

const MAX_IMAGE_B64 = 6_000_000; // ~4 MB binary

export async function geminiJson(
  prompt: string,
  image?: { base64: string; mime: string },
): Promise<Record<string, unknown> | null> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return null;
  if (image && image.base64.length > MAX_IMAGE_B64) {
    throw new Error("Image too large (max ~4 MB)");
  }
  const parts: Record<string, unknown>[] = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}
