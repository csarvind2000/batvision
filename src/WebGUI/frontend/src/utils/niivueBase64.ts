// src/utils/niivueBase64.ts

function normalizeBase64(b64: string): string {
  if (!b64) return "";
  let s = b64.replace(/[\r\n\s]/g, "");
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad !== 0) throw new Error("Invalid base64 length (corrupted data)");
  return s;
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const s = normalizeBase64(b64);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function uint8ArrayToBase64(u8: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64NiftiToObjectUrl(
  b64: string,
  mime: string = "application/gzip"
): { url: string; cleanup: () => void } {
  const bytes = base64ToUint8Array(b64);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  console.log("[B64] created objectURL", { mime, bytes: bytes.length, urlPreview: url.slice(0, 48) + "..." });
  return { url, cleanup: () => URL.revokeObjectURL(url) };
}