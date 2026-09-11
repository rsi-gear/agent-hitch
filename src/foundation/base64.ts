/** Validate padded Base64 without recursive regex groups on large artifacts. */
export function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let end = value.length;
  if (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  if (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47) continue;
    return false;
  }
  return true;
}
