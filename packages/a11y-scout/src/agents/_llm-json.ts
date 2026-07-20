import { jsonrepair } from "jsonrepair";

/**
 * Parse JSON from an LLM response. Falls back to jsonrepair() for the
 * common LLM failure modes: trailing commas, missing commas between
 * objects in an array, unescaped quotes, single quotes, missing braces.
 * gpt-oss-120b in particular emits these maybe 1 out of every 4 responses.
 */
export function parseJsonLenient(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(jsonrepair(raw));
  }
}

/**
 * Extract the first JSON object from a model response.
 * Tolerates models that wrap JSON in markdown fences or prose.
 * Returns an empty findings stub if nothing recognisable is found, so callers
 * can always feed the result to parseJsonLenient without a separate null check.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  if (!candidate) return '{"findings":[]}';
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return '{"findings":[]}';
  }
  return candidate.slice(start, end + 1);
}
