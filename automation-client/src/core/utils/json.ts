export function extractFirstJsonArray(text: string): any[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in LLM response');
  }
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice) as any[];
}

export function extractFirstJsonObject(text: string): any {
  const raw = text.trim();

  // 0) Fast-path: full payload is already JSON (object or encoded JSON string).
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') {
      const parsedInner = JSON.parse(parsed);
      if (parsedInner && typeof parsedInner === 'object' && !Array.isArray(parsedInner)) {
        return parsedInner;
      }
    }
  } catch {
    // continue with tolerant extraction below
  }

  // 1) Prefer fenced JSON block if present.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced);
    } catch {
      // fallback to generic scanner below
    }
  }

  // 2) Find first balanced JSON object candidate and parse.
  const starts: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') starts.push(i);
  }

  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('No JSON object found in LLM response');
}

