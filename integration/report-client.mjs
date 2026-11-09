/**
 * LOOP's documented Sites API, not the separate hackathon backend API.
 * No government submission method exists in this client.
 * Storage, identity, ownership and approval MUST also be enforced server-side.
 */
export class ReportApiError extends Error {
  constructor(code, message, { status = 0, uncertain = false } = {}) {
    super(message);
    this.name = 'ReportApiError';
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
  }
}

const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const invalid = (message) => { throw new ReportApiError('INVALID_INPUT', message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function versionOf(version) {
  if (!Number.isSafeInteger(version) || version < 0) invalid('A server-issued nonnegative integer version is required.');
  return version;
}
function idOf(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) invalid('Invalid report identifier.');
  return id;
}
function copyInput(input) {
  if (!isObject(input)) invalid('Report input must be an object.');
  // The deployed ReportInput type is not present in this repository. Preserve
  // the existing UI's input object and let the server validate its fields.
  // Never invent a location schema or silently drop values during serialization.
  let serialized;
  try {
    serialized = JSON.stringify(input, (_key, value) => {
      if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' ||
          typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error('Not JSON data');
      }
      return value;
    });
  } catch { invalid('Report input must contain finite, JSON-serializable values.'); }
  if (serialized.length > 32768) invalid('The report text is too large.');
  return JSON.parse(serialized);
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

/** Create once and retain until the draft save is reconciled; retries reuse this exact object. */
export function prepareDraft(input, requestId = globalThis.crypto.randomUUID()) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) invalid('Invalid request identifier.');
  return freezeDeep({ input: copyInput(input), request_id: requestId });
}

/** MIME AND signature checks; the server remains responsible for full decoding/security. */
export async function validatePhoto(file) {
  if (!(file instanceof Blob) || !file.size || file.size > MAX_PHOTO) invalid('Choose a nonempty photo no larger than 8 MiB.');
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = (start, end) => String.fromCharCode(...b.slice(start, end));
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => b[i] === n);
  const webp = b.length >= 12 && text(0,4) === 'RIFF' && text(8,12) === 'WEBP';
  const expected = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : null;
  if (!expected || file.type !== expected) invalid('Use a JPEG, PNG or WebP photo with matching file contents. HEIC must be converted first.');
  return { mime: expected, extension: jpeg ? 'jpg' : png ? 'png' : 'webp', size: file.size };
}

async function readBounded(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE) throw new Error('Response exceeds the size limit.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0, result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw new Error('Response exceeds the size limit.');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export class ReportClient {
  #base; #fetch; #timeout;
  constructor({ baseUrl = globalThis.location?.origin, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { invalid('A backend origin is required.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) invalid('Use HTTPS, or loopback HTTP for local development.');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid('Configure only an origin, without credentials, a path or a query.');
    if (globalThis.location?.origin && url.origin !== globalThis.location.origin) invalid('Serve the client on the same origin as the API. Cross-origin private-data forwarding is disabled.');
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) invalid('Invalid transport configuration.');
    this.#base = url.origin;
    this.#fetch = fetchImpl;
    this.#timeout = timeoutMs;
  }

  async #request(path, { method = 'GET', body, type = 'json', signal } = {}) {
    const write = method !== 'GET';
    const controller = new AbortController();
    if (signal?.aborted) throw new ReportApiError('CANCELLED', 'Request was cancelled before sending.');
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.#timeout);
    const headers = { Accept: type === 'json' ? 'application/json' : 'text/plain' };
    if (isObject(body) && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    try {
      const response = await this.#fetch(this.#base + path, {
        method, headers, body, signal: controller.signal, credentials: 'same-origin',
        redirect: 'error', cache: 'no-store', referrerPolicy: 'same-origin',
      });
      if (response.redirected) throw new ReportApiError('UNEXPECTED_REDIRECT', 'Sign-in or an unexpected redirect interrupted the request.', { uncertain: write });
      const text = await readBounded(response);
      const json = response.headers.get('content-type')?.includes('application/json');
      let data;
      try { data = json && text ? JSON.parse(text) : null; } catch { /* Handled below. */ }
      if (!response.ok) {
        const code = response.status === 401 ? 'SIGN_IN_REQUIRED' : response.status === 409 ? 'CONFLICT' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
        const message = typeof data?.error === 'string' ? data.error.slice(0,1000) : `Request failed (${response.status}).`;
        throw new ReportApiError(code, message, { status: response.status, uncertain: write && response.status >= 500 });
      }
      if (response.status === 204) return null;
      if (type === 'text') {
        if (!response.headers.get('content-type')?.startsWith('text/plain')) throw new ReportApiError('INVALID_RESPONSE', 'Expected a plain-text report packet.');
        return text;
      }
      if (!json || data === undefined || data === null) throw new ReportApiError('INVALID_RESPONSE', 'Expected JSON; a login page or misconfigured backend may have responded.', { uncertain: write });
      return data;
    } catch (error) {
      if (error instanceof ReportApiError) throw error;
      throw new ReportApiError(controller.signal.aborted ? 'CANCELLED_OR_TIMED_OUT' : 'NETWORK_ERROR',
        write ? 'The result is unknown. Reconcile with the server before retrying; do not create a new request ID.' : 'Could not read the server response. Check the connection and sign-in.',
        { uncertain: write });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  capabilities({ signal } = {}) { return this.#request('/api/capabilities', { signal }); }
  session({ signal } = {}) { return this.#request('/api/session', { signal }); }
  listReports({ signal } = {}) { return this.#request('/api/reports', { signal }); }
  getReport(id, { signal } = {}) { return this.#request(`/api/reports/${idOf(id)}`, { signal }); }

  saveDraft(prepared, { locationConfirmed = false, signal } = {}) {
    if (locationConfirmed !== true) invalid('Confirm the issue location before saving.');
    if (!isObject(prepared) || typeof prepared.request_id !== 'string') invalid('Prepare the draft first and retain its request ID.');
    const checked = prepareDraft(prepared.input, prepared.request_id);
    return this.#request('/api/reports', { method: 'POST', body: checked, signal });
  }
  editReport(id, input, version, { locationConfirmed = false, signal } = {}) {
    if (locationConfirmed !== true) invalid('Confirm the issue location before editing.');
    return this.#request(`/api/reports/${idOf(id)}`, { method: 'PATCH', body: { input: copyInput(input), version: versionOf(version) }, signal });
  }
  async uploadPhoto(id, file, version, { signal } = {}) {
    const path = `/api/reports/${idOf(id)}/photo`;
    versionOf(version);
    const { extension } = await validatePhoto(file);
    const form = new FormData();
    form.append('photo', file, `evidence.${extension}`); // Do not leak a personal filename.
    form.append('version', String(version));
    return this.#request(path, { method: 'POST', body: form, signal });
  }
  approveHandoff(id, version, { consent = false, signal } = {}) {
    if (consent !== true) invalid('Explicit review consent is required. Approval does not submit to an agency.');
    return this.#request(`/api/reports/${idOf(id)}/approve`, { method: 'POST', body: { version: versionOf(version), consent: true }, signal });
  }
  getPacket(id, { format = 'json', signal } = {}) {
    if (!['json', 'text'].includes(format)) invalid('Packet format must be json or text.');
    const suffix = format === 'text' ? '.txt' : '';
    return this.#request(`/api/reports/${idOf(id)}/packet${suffix}`, { type: format === 'text' ? 'text' : 'json', signal });
  }
}
