export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const payload = (await res.json().catch(() => null)) as
    | { ok: boolean; data?: T; error?: string }
    | null;
  if (!res.ok || !payload?.ok) {
    throw new ApiError(payload?.error ?? `HTTP ${res.status}`, res.status);
  }
  return payload.data as T;
}
