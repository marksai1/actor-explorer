/**
 * RFC 4180 CSV reader. Film titles are full of commas, quotes and the odd
 * newline, so this is a proper state machine rather than a split on ','.
 */

export function parseCsvRows(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch; // newlines and commas inside quotes are literal
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else if (ch === '\r') {
      // handled by the \n that follows
    } else {
      field += ch;
      started = true;
    }
  }

  if (started || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
}

/** Parse into objects keyed by header name. Header lookup is case-insensitive. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseCsvRows(input);
  const header = rows.shift();
  if (!header) return [];

  const keys = header.map((h) => h.trim());
  return rows.map((row) => {
    const record: Record<string, string> = {};
    keys.forEach((keyName, index) => {
      record[keyName] = (row[index] ?? '').trim();
    });
    return record;
  });
}

/** Case/spacing-tolerant field read, since header casing has drifted over time. */
export function field(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== '') return row[name]!;
  }
  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = names.map(normalized);
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(normalized(key)) && value !== '') return value;
  }
  return '';
}

export function toNumber(value: string): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Letterboxd/IMDb dates are already ISO-ish; keep just the date part. */
export function toIsoDate(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}
