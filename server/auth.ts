/// <reference types="@cloudflare/workers-types" />

/** 不要调大：100000 是 Cloudflare workerd 的硬上限，超过会在线上抛 NotSupportedError，而 wrangler dev / Node 不报错 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 100_000;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  if (PBKDF2_ITERATIONS > PBKDF2_MAX_ITERATIONS) {
    throw new Error(
      `PBKDF2_ITERATIONS=${PBKDF2_ITERATIONS} 超出 Cloudflare workerd 的上限 ${PBKDF2_MAX_ITERATIONS}，线上会 NotSupportedError`,
    );
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterText, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterText || !saltB64 || !hashB64) return false;
  const iterations = Number(iterText);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    return false;
  }
  let bits: Uint8Array;
  try {
    bits = new Uint8Array(await pbkdf2Bits(password, fromBase64(saltB64), iterations));
  } catch {
    return false;
  }
  const expected = fromBase64(hashB64);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i += 1) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

const DUMMY_HASH =
  "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export async function burnPasswordTime(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

export function generateSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

export function generateApiKey(): string {
  return `acb_${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export const SESSION_COOKIE = "acb_session";
export const SESSION_TTL_DAYS = 30;

/** SameSite=None 是扩展 background 带 Cookie 所需，必须配合 isAllowedOrigin 与 public/_headers 的 frame-ancestors */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_DAYS * 86_400): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; Path=/; Max-Age=${maxAgeSeconds}; SameSite=None`;
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9]+)`));
  return match ? match[1] : null;
}
