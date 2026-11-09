import { assert, validateDelivery } from './schema.mjs';

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const pushField = () => { row.push(field); field = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; } else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      pushField();
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('malformed CSV'); field += c; }
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (field || row.length || closed) { pushField(); rows.push(row); }
  return rows;
}
export function validateSubmission(bytes, input) {
  const schema = validateDelivery(input);
  assert(bytes.length <= schema.maxBytes, 'submission exceeds byte limit');
  const [fields, ...rows] = parseCsv(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert(JSON.stringify(fields) === JSON.stringify([schema.idColumn, ...schema.targetColumns]), 'unexpected submission columns');
  assert(rows.length === schema.predictIds.length, 'submission row count mismatch');
  rows.forEach((row, i) => {
    assert(row.length === fields.length && row[0] === schema.predictIds[i], 'submission ID/order mismatch');
    for (const value of row.slice(1)) assert(schema.valueType === 'label' ? schema.labels.includes(value)
      : value.trim() !== '' && Number.isFinite(Number(value)) && (schema.valueType === 'number' || Number(value) >= 0)
        && (schema.valueType !== 'probability' || Number(value) <= 1), 'prediction value outside declared domain');
  });
  return { rows: rows.length };
}
