// A content hint for the upload UI, not a file validator. Never use this result
// to bypass the server's upload checks.
export const RECOGNITION_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES = 256 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const result = (format, reason) => ({ format, reason });

const OFFICE = {
  DOCX: ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'document'],
  PPTX: ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', 'presentation'],
  XLSX: ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'workbook'],
};

function read32(view, offset) { return view.getUint32(offset, true); }
function read16(view, offset) { return view.getUint16(offset, true); }

async function zipEntryText(raw, entry) {
  if (entry.uncompressed > MAX_OFFICE_XML_BYTES || entry.compressed > MAX_OFFICE_XML_BYTES) return null;
  const compressed = raw.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressed) return null;
    return decoder.decode(compressed);
  }
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_OFFICE_XML_BYTES || length > entry.uncompressed) return null;
      chunks.push(value);
    }
    if (length !== entry.uncompressed) return null;
    const joined = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
    return decoder.decode(joined);
  } finally {
    if (length > MAX_OFFICE_XML_BYTES || length > entry.uncompressed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseXml(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml) || typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  return document.querySelector('parsererror') ? null : document.documentElement;
}

function localName(element) { return element?.localName || null; }

async function recognizeZip(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let end = -1;
  for (let at = raw.length - 22; at >= Math.max(0, raw.length - 65_557); at -= 1) {
    if (read32(view, at) === 0x06054b50 && at + 22 + read16(view, at + 20) === raw.length) {
      end = at;
      break;
    }
  }
  if (end < 0 || read16(view, end + 4) !== 0 || read16(view, end + 6) !== 0) {
    return result('UNKNOWN', 'invalid_zip_directory');
  }
  const count = read16(view, end + 10);
  const size = read32(view, end + 12);
  const offset = read32(view, end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff
      || count > MAX_ZIP_ENTRIES || size > 2 * 1024 * 1024 || offset + size !== end) {
    return result('UNKNOWN', 'invalid_zip_directory');
  }
  const entries = new Map();
  let at = offset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || read32(view, at) !== 0x02014b50) return result('UNKNOWN', 'invalid_zip_entry');
    const flags = read16(view, at + 8);
    const method = read16(view, at + 10);
    const compressed = read32(view, at + 20);
    const uncompressed = read32(view, at + 24);
    const nameLength = read16(view, at + 28);
    const extraLength = read16(view, at + 30);
    const commentLength = read16(view, at + 32);
    const localOffset = read32(view, at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method)) return result('UNKNOWN', 'unsupported_zip_entry');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      return result('UNKNOWN', 'unsupported_zip_entry');
    }
    expanded += uncompressed;
    if (expanded > MAX_ZIP_EXPANDED_BYTES) return result('UNKNOWN', 'zip_expansion_limit');
    let name;
    try { name = decoder.decode(raw.subarray(at + 46, at + 46 + nameLength)); }
    catch { return result('UNKNOWN', 'invalid_zip_name'); }
    if (!name || entries.has(name) || localOffset + 30 > offset || read32(view, localOffset) !== 0x04034b50) {
      return result('UNKNOWN', 'invalid_zip_entry');
    }
    const localNameLength = read16(view, localOffset + 26);
    const localExtraLength = read16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > offset || read16(view, localOffset + 8) !== method
        || read16(view, localOffset + 6) !== flags) return result('UNKNOWN', 'invalid_zip_entry');
    try {
      if (decoder.decode(raw.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name) {
        return result('UNKNOWN', 'invalid_zip_entry');
      }
    } catch { return result('UNKNOWN', 'invalid_zip_name'); }
    entries.set(name, { method, compressed, uncompressed, dataOffset });
    at = next;
  }
  if (at !== end) return result('UNKNOWN', 'invalid_zip_directory');

  const officeLabels = Object.entries(OFFICE).filter(([, [part]]) => entries.has(part));
  if (officeLabels.length > 1) return result('UNKNOWN', 'conflicting_office_parts');
  if (officeLabels.length) {
    if (!entries.has('[Content_Types].xml') || !entries.has('_rels/.rels')) {
      return result('UNKNOWN', 'incomplete_office_package');
    }
    const [format, [part, contentType, expectedRoot]] = officeLabels[0];
    const xml = await Promise.all(['[Content_Types].xml', '_rels/.rels', part]
      .map((name) => zipEntryText(raw, entries.get(name))));
    if (xml.some((value) => value === null)) return result('UNKNOWN', 'invalid_office_xml');
    const [types, rels, main] = xml.map(parseXml);
    if (localName(types) !== 'Types' || localName(rels) !== 'Relationships'
        || localName(main) !== expectedRoot) return result('UNKNOWN', 'invalid_office_xml');
    const hasManifest = [...types.children].some((child) => child.getAttribute('PartName') === `/${part}`
      && child.getAttribute('ContentType') === contentType);
    return hasManifest ? result(format, 'office_manifest_and_main_part')
      : result('UNKNOWN', 'office_manifest_mismatch');
  }
  if (entries.has('[Content_Types].xml') || entries.has('mimetype')
      || (entries.has('META-INF/manifest.xml') && entries.has('content.xml'))) {
    return result('UNKNOWN', 'other_zip_package');
  }
  return result('ZIP', 'valid_zip_directory');
}

function numberCell(value) { return value.trim() !== '' && Number.isFinite(Number(value)); }

function parseDelimited(value, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quoted) {
      if (char === '"' && value[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (char === '"' && cell === '' && !afterQuote) quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; afterQuote = false; }
    else if (char === '\n' || char === '\r') {
      row.push(cell);
      if (row.some((part) => part !== '')) rows.push(row);
      row = []; cell = ''; afterQuote = false;
      if (char === '\r' && value[i + 1] === '\n') i += 1;
    } else if (afterQuote && char !== ' ' && char !== '\t') return null;
    else if (char === '"') return null;
    else cell += char;
  }
  if (quoted) return null;
  row.push(cell);
  if (row.some((part) => part !== '')) rows.push(row);
  return rows;
}

function csvCandidates(value) {
  const candidates = [];
  let ambiguous = false;
  for (const delimiter of [',', '\t', ';', '|']) {
    const rows = parseDelimited(value, delimiter);
    if (!rows || rows.length < 2 || rows[0].length < 2
        || rows.some((row) => row.length !== rows[0].length)) continue;
    if (rows.length < 3 || !rows.slice(1).some((row) => row.some(numberCell))) ambiguous = true;
    else candidates.push(delimiter);
  }
  return { candidates, ambiguous };
}

function csvAfterPreamble(value) {
  if (value.length > 256 * 1024) return [];
  const lines = value.split(/\r?\n/u);
  const matches = [];
  for (const delimiter of [',', '\t', ';', '|']) {
    let chars = 0;
    for (let start = 1; start <= Math.min(32, lines.length - 3); start += 1) {
      chars += lines[start - 1].length + 1;
      if (chars > 4096) break;
      const preceding = parseDelimited(lines[start - 1], delimiter);
      if (!preceding || preceding.some((row) => row.length !== 1)) break;
      const rows = parseDelimited(lines.slice(start).join('\n'), delimiter);
      if (!rows || rows.length < 3 || rows[0].length < 3
          || rows.some((row) => row.length !== rows[0].length)) continue;
      const header = rows[0].map((cell) => cell.trim());
      if (new Set(header).size !== header.length
          || header.some((cell) => !/^[A-Za-z_][\w .()/%+-]{0,63}$/u.test(cell))
          || rows.slice(1, 3).some((row) => !row.some(numberCell))) continue;
      matches.push(delimiter);
      break;
    }
  }
  return matches;
}

export async function recognizeBytes(input) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!raw.length || raw.length > RECOGNITION_MAX_BYTES) return result('UNKNOWN', 'input_limit');
  if (raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46 && raw[4] === 0x2d) {
    const head = new TextDecoder('ascii').decode(raw.subarray(0, 8));
    const tailStart = Math.max(0, raw.length - 2048);
    const tail = new TextDecoder('ascii').decode(raw.subarray(tailStart));
    const match = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(tail);
    const offset = match ? Number(match[1]) : -1;
    const target = offset >= 0 && offset < raw.length
      ? new TextDecoder('ascii').decode(raw.subarray(offset, offset + 1024)) : '';
    return /^%PDF-\d\.\d/u.test(head) && (target.startsWith('xref')
      || (/^\d+\s+\d+\s+obj\b/u.test(target) && /\/Type\s*\/XRef\b/u.test(target)))
      ? result('PDF', 'pdf_header_and_cross_reference') : result('UNKNOWN', 'incomplete_pdf');
  }
  if (raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4b
      && ((raw[2] === 3 && raw[3] === 4) || (raw[2] === 5 && raw[3] === 6))) {
    try { return await recognizeZip(raw); }
    catch { return result('UNKNOWN', 'invalid_zip_or_office_package'); }
  }
  const knownBinary = (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)
    || (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff)
    || (raw[0] === 0x1f && raw[1] === 0x8b)
    || (raw.length > 12 && new TextDecoder('ascii').decode(raw.subarray(0, 4)) === 'RIFF');
  if (knownBinary) return result('UNKNOWN', 'other_binary_format');
  let value;
  try { value = decoder.decode(raw); }
  catch { return result('UNKNOWN', 'unrecognized_binary_or_encoding'); }
  value = value.replace(/^\uFEFF/u, '');
  if (!value.trim() || /[\u0000-\u0008\u000B\u000E-\u001F]/u.test(value)) {
    return result('UNKNOWN', 'empty_or_control_character_text');
  }
  const trimmed = value.trimStart();
  if (trimmed.startsWith('<')) return result('UNKNOWN', 'markup_or_ambiguous_text');
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return result('JSON', 'parsed_json_object_or_array');
    return result('UNKNOWN', 'ambiguous_json_scalar');
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return result('UNKNOWN', 'malformed_json_like_text');
  }
  const { candidates, ambiguous } = csvCandidates(value);
  if (candidates.length === 1) return result('CSV', 'consistent_delimited_table');
  if (candidates.length > 1) return result('UNKNOWN', 'ambiguous_delimiters');
  if (ambiguous) return result('UNKNOWN', 'ambiguous_text_table');
  const preamble = csvAfterPreamble(value);
  if (preamble.length === 1) return result('CSV', 'delimited_table_after_text_preamble');
  if (preamble.length > 1) return result('UNKNOWN', 'ambiguous_delimiters_after_preamble');
  return result('TXT', 'unstructured_utf8_text');
}

export async function recognizeFile(file) {
  if (!file || typeof file.size !== 'number' || file.size > RECOGNITION_MAX_BYTES) {
    return result('UNKNOWN', 'input_limit');
  }
  try { return await recognizeBytes(await file.slice(0, RECOGNITION_MAX_BYTES + 1).arrayBuffer()); }
  catch { return result('UNKNOWN', 'unreadable_file'); }
}
