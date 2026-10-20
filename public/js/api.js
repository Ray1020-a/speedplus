export const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  },
  async post(url, body, token) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { 'x-admin-token': token }) },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
    return data;
  },
  assets: (kind) => api.get(`/api/assets/${kind}`),
};

export function fmtTime(ms) {
  if (ms == null || !isFinite(ms)) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}
