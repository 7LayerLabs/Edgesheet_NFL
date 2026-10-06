/**
 * Streaming CSV reader for the large nflverse files (play-by-play is about 100 MB a season). Same rules as
 * scripts/lib/csv.mjs (quoted fields, doubled quotes, newlines inside quotes), but it reads the file in chunks
 * and never holds the whole text, so a season fits in a small memory budget. Gzipped files (.gz) are inflated
 * on the fly. `onRow` gets one object per row; return value resolves when the file is done.
 *
 * `keep` (optional) limits the columns copied into each row object, which keeps memory flat on 370-column files.
 */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

export function streamCsv(file, onRow, keep) {
  return new Promise((resolve, reject) => {
    let source = createReadStream(file);
    if (file.endsWith(".gz")) source = source.pipe(createGunzip());
    source.setEncoding("utf8");
    let header = null;
    let idx = null; // [name, position] pairs to copy
    let field = "";
    let record = [];
    let inQuotes = false;
    let pendingQuote = false; // a quote ended the last chunk inside a quoted field
    const emit = () => {
      record.push(field);
      field = "";
      if (!header) {
        header = record;
        idx = (keep ? header.map((h, i) => [h, i]).filter(([h]) => keep.includes(h)) : header.map((h, i) => [h, i]));
      } else if (record.length > 1 || record[0] !== "") {
        const obj = {};
        for (const [h, i] of idx) obj[h] = record[i] ?? "";
        onRow(obj);
      }
      record = [];
    };
    source.on("data", (chunk) => {
      let i = 0;
      if (pendingQuote) {
        pendingQuote = false;
        if (chunk[0] === '"') {
          field += '"';
          i = 1;
        } else inQuotes = false;
      }
      for (; i < chunk.length; i++) {
        const c = chunk[i];
        if (inQuotes) {
          if (c === '"') {
            if (i + 1 === chunk.length) pendingQuote = true;
            else if (chunk[i + 1] === '"') {
              field += '"';
              i++;
            } else inQuotes = false;
          } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") {
          record.push(field);
          field = "";
        } else if (c === "\n") emit();
        else if (c !== "\r") field += c;
      }
    });
    source.on("end", () => {
      if (pendingQuote) inQuotes = false;
      if (field !== "" || record.length) emit();
      resolve();
    });
    source.on("error", reject);
  });
}
