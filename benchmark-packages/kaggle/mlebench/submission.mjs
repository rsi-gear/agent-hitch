import { assert } from '../../../integrations/analysis/protocol.mjs'

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false
  const pushField = () => { row.push(field); field = ''; closed = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true } else field += c
    } else if (c === ',' || c === '\n' || c === '\r') {
      pushField()
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++ }
    } else if (c === '"' && !field && !closed) quoted = true
    else { if (closed || c === '"') throw new Error('malformed CSV'); field += c }
  }
  if (quoted) throw new Error('unterminated CSV quote')
  if (field || row.length || closed) { pushField(); rows.push(row) }
  return rows
}

export function validateSubmission(bytes, schema) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('submission exceeds limit')
  const rows = parseCsv(bytes.toString('utf8'))
  if (JSON.stringify(rows.shift()) !== JSON.stringify([schema.id_column, schema.target_column])) throw new Error('unexpected submission columns')
  const expected = new Set(schema.expected_ids.map(String))
  if (expected.size !== schema.rows || rows.length !== expected.size) throw new Error('submission row count mismatch')
  for (const row of rows) {
    if (row.length !== 2 || !expected.delete(row[0]) || !schema.allowed_labels.map(String).includes(row[1])) throw new Error('invalid submission ID or label')
  }
  if (expected.size) throw new Error('missing submission IDs')
}


export function validateTabularSubmission(bytes, task) {
  const s = task.prediction
  if (s.kind !== 'tabular') return validateSubmission(bytes, { id_column: s.idColumn, target_column: s.targetColumn,
    expected_ids: task.predictIds, rows: task.predictIds.length, allowed_labels: s.allowedLabels })
  const [columns, ...rows] = parseCsv(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  assert(JSON.stringify(columns) === JSON.stringify([s.idColumn, ...s.targetColumns]), 'submission columns differ')
  assert(rows.length === task.predictIds.length, 'submission row count differs')
  rows.forEach((row, i) => {
    assert(row.length === columns.length && row[0] === task.predictIds[i], 'submission must use canonical sample/test ID order')
    for (const value of row.slice(1)) assert(s.metric === 'accuracy' ? s.labels.includes(value)
      : value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && (s.metric !== 'auc-roc' || Number(value) <= 1), 'invalid prediction value')
  })
  return { rows: rows.length }
}
