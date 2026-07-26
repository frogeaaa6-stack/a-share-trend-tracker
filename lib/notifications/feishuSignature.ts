export async function createFeishuSignature(timestamp: string, secret: string) {
  const keyMaterial = new TextEncoder().encode(`${timestamp}\n${secret}`);
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array()));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
