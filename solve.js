// Fast drop-in for csv-reader 1.0.0: single left-to-right pass, slice-based
// field extraction, indexOf jumps over quoted segments. Returns exactly
// {columns, rows, errors} as the reference for every input.
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = n > 0 && text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  // Scratch outputs of the field parsers (avoids per-field object allocation).
  let fValue = '';
  let fEnded = 2; // 0 comma, 1 line break, 2 end
  let fAdded = 0;

  // Segment of a quoted field, text[a..b): CRLF and lone CR become LF,
  // and `line` advances by the number of line breaks it holds.
  // nextCR / nextLF cache the next CR / LF at or after the last search start
  // (n when none), so LF-only or CR-free texts are not rescanned to the end
  // for every quoted segment. Positions only move forward.
  let nextCR = -1;
  let nextLF = -1;
  function segment(a, b) {
    if (a >= b) return '';
    if (nextCR < a) { nextCR = text.indexOf('\r', a); if (nextCR === -1) nextCR = n; }
    if (nextCR >= b) {
      if (nextLF < a) { nextLF = text.indexOf('\n', a); if (nextLF === -1) nextLF = n; }
      while (nextLF < b) { line += 1; nextLF = text.indexOf('\n', nextLF + 1); if (nextLF === -1) nextLF = n; }
      return text.slice(a, b);
    }
    const s = text.slice(a, b).replace(/\r\n|\r/g, '\n');
    let cnt = 0;
    let i = s.indexOf('\n');
    while (i !== -1) { cnt += 1; i = s.indexOf('\n', i + 1); }
    line += cnt;
    return s;
  }

  // Unquoted characters from pos, on top of `prefix`, up to the next comma
  // or line break. A CR not followed by LF is dropped (stray_cr).
  function parseUnquoted(prefix) {
    let segStart = pos;
    let parts = null;
    let added = 0;
    fEnded = 2;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) { fEnded = 0; break; }
      if (c === 10) { fEnded = 1; break; }
      if (c === 13) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) { fEnded = 1; break; }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, pos));
        added += pos - segStart;
        pos += 1;
        segStart = pos;
        continue;
      }
      pos += 1;
    }
    added += pos - segStart;
    const tail = text.slice(segStart, pos);
    fValue = parts === null ? prefix + tail : prefix + (parts.push(tail), parts.join(''));
    fAdded = added;
    if (fEnded === 0) pos += 1;
    else if (fEnded === 1) { pos += text.charCodeAt(pos) === 13 ? 2 : 1; line += 1; }
  }

  // A field whose opening quote is at pos.
  function parseQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let closed = false;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        const seg = segment(segStart, q);
        if (parts === null) parts = [seg, '"']; else parts.push(seg, '"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      const seg = segment(segStart, q);
      fValue = parts === null ? seg : (parts.push(seg), parts.join(''));
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      nextCR = -1; // pos moved back: drop the forward-only caches
      nextLF = -1;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      parseUnquoted('"');
      return;
    }
    if (pos >= n) { fEnded = 2; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fEnded = 0; return; }
    if (c === 10) { pos += 1; line += 1; fEnded = 1; return; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; fEnded = 1; return; }
    // What follows the closing quote is appended as it stands.
    parseUnquoted(fValue);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    while (true) {
      if (pos < n && text.charCodeAt(pos) === 34) { lastQuoted = true; parseQuoted(); }
      else { lastQuoted = false; parseUnquoted(''); }
      fields.push(fValue);
      if (fEnded !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
