/** AES-256-GCM for GitHub tokens at rest (SPEC 3.2). Output: base64(iv | tag | ciphertext). */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function seal(key: Buffer, plain: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
	return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function unseal(key: Buffer, sealed: string): string {
	const raw = Buffer.from(sealed, "base64");
	const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(12, 28));
	return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
