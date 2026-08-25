import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|\s*$)/i;
const CHARSET_PARAMETER = /(?:^|;)\s*charset\s*=\s*([^;\s]+)/i;
const CONTENT_DIGEST = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/;

/**
 * Agent-authenticated JSON POST/PATCH mutations must prove their exact raw
 * bytes. Board/browser and non-JSON mutations retain their existing contract.
 */
export const agentTextMutationIntegrity: RequestHandler = (req, res, next) => {
  const contentType = req.header("content-type");
  if (req.actor?.type !== "agent" || !["POST", "PATCH"].includes(req.method) || !contentType || !JSON_CONTENT_TYPE.test(contentType)) {
    return next();
  }
  const charset = contentType?.match(CHARSET_PARAMETER)?.[1]?.replace(/^['"]|['"]$/g, "").toLowerCase();
  if (charset !== "utf-8" && charset !== "utf8") {
    return res.status(428).json({ error: "Agent JSON mutations require Content-Type: application/json; charset=utf-8." });
  }

  const expectedDigest = parseContentDigest(req.header("content-digest"));
  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!expectedDigest || !rawBody || !safeEqual(expectedDigest, digest(rawBody))) {
    return res.status(400).json({ error: "Content-Digest must match the exact UTF-8 JSON request bytes." });
  }
  if (containsCorruptionMarker(req.body)) {
    return res.status(422).json({ error: "JSON mutation contains the demonstrated text-encoding corruption marker (four or more consecutive question marks)." });
  }
  return next();
};

function containsCorruptionMarker(value: unknown): boolean {
  if (typeof value === "string") return /\?{4,}/.test(value);
  if (Array.isArray(value)) return value.some(containsCorruptionMarker);
  if (value && typeof value === "object") return Object.values(value).some(containsCorruptionMarker);
  return false;
}

function parseContentDigest(value: string | undefined): Buffer | undefined {
  const encoded = value?.match(CONTENT_DIGEST)?.[1];
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 ? decoded : undefined;
}

function digest(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
