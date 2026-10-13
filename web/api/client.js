export async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败：${response.status}`);
    error.code = payload.code || null;
    error.status = response.status;
    throw error;
  }
  return payload;
}
