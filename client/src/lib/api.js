// REST client for the NullChat API.
const TOKEN_KEY = 'nullchat.token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token, remember = true) {
  try {
    localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
    if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.errors = body?.errors || {};
    this.retryAfter = body?.retryAfter;
    this.data = body || {};   // the whole answer, for the few places that need more than the message
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(method, path, body, opts = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
    headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, { message: 'Can’t reach NullChat. Check your connection.' });
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }
  if (!res.ok) {
    if (res.status === 401 && !opts.noAuthRedirect) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data;
}

api.get = (p, o) => api('GET', p, undefined, o);
api.post = (p, b, o) => api('POST', p, b, o);
api.put = (p, b, o) => api('PUT', p, b, o);
api.patch = (p, b, o) => api('PATCH', p, b, o);
api.del = (p, b, o) => api('DELETE', p, b, o);

/** Upload a file with progress reporting (uses XHR because fetch has no upload progress). */
export function uploadFile(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(path.startsWith('/api') ? 'POST' : 'POST', `/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { message: 'Upload failed. Check your connection.' }));
    xhr.send(file);
  });
}

/** PUT raw image bytes (avatars, banners, icons). */
export function putImage(path, file) {
  return api('PUT', path, file);
}
