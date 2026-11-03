/** SPEC 8: GitHub signs every webhook body with HMAC-SHA256 of the shared secret. */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(secret: string, body: Buffer, header: string): boolean {
	if (!secret || !header.startsWith("sha256=")) return false;
	const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
	const got = Buffer.from(header);
	return got.length === want.length && timingSafeEqual(got, want);
}
