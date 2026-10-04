/**
 * Minimal CSV reader for the nflverse release files. Handles quoted fields,
 * doubled quotes, and newlines inside quotes. Reads the whole file (the largest
 * we use, play-by-play, is tens of MB) and calls `onRow` with an object per row,
 * or returns the rows when no callback is given. Empty strings stay empty strings;
 * the caller decides what is numeric.
 */
import { readFile } from "node:fs/promises";

export async function readCsv(file, onRow) {
  const text = await readFile(file, "utf8");
  return parseCsv(text, onRow);
}

export function parseCsv(text, onRow) {
  const rows = onRow ? undefined : [];
  let header = null;
  let field = "";
  let record = [];
  let inQuotes = false;
  const n = text.length;
  const emit = () => {
    record.push(field);
    field = "";
    if (!header) {
      header = record;
    } else if (record.length > 1 || record[0] !== "") {
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = record[i] ?? "";
      if (onRow) onRow(obj);
      else rows.push(obj);
    }
    record = [];
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n") emit();
    else if (c === "\r") {
      // CRLF: skip, the \n emits
    } else field += c;
  }
  if (field !== "" || record.length) emit();
  return rows;
}

export const num = (v) => {
  if (v === "" || v === undefined || v === null || v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
export const bool = (v) => v === "TRUE" || v === "true" || v === "1";
