import assert from "node:assert/strict";
import { deflateSync } from "zlib";
import {
  clipAttachmentText,
  extractPdfText,
  looksLikeText,
} from "../src/lib/file_text";

assert.equal(looksLikeText("Распиновка MS41\nпин 1 — плюс"), true);
assert.equal(looksLikeText("a\u0000b\u0000c"), false);

const clipped = clipAttachmentText("A".repeat(100) + "MIDDLE" + "Z".repeat(100), 80);
assert.equal(clipped.clipped, true);
assert.ok(clipped.text.startsWith("A"));
assert.ok(clipped.text.endsWith("Z"));
assert.ok(clipped.text.includes("середина файла опущена"));

const plain = [
  "%PDF-1.4",
  "1 0 obj << /Length 48 >> stream",
  "BT (Hello pinout) Tj ET",
  "endstream endobj",
  "%%EOF",
].join("\n");
assert.match(extractPdfText(Buffer.from(plain)), /Hello pinout/);

const payload = Buffer.from("BT (Compressed pin 12) Tj ET");
const deflated = deflateSync(payload);
const compressed = [
  "%PDF-1.4",
  `1 0 obj << /Filter /FlateDecode /Length ${deflated.length} >> stream\n`,
].join("\n");
const pdf = Buffer.concat([
  Buffer.from(compressed),
  deflated,
  Buffer.from("\nendstream endobj\n%%EOF"),
]);
assert.match(extractPdfText(pdf), /Compressed pin 12/);

console.log("file_text tests passed");
