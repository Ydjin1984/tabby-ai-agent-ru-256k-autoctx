import assert from "node:assert/strict";
import { createZip } from "../src/lib/zip";

const zip = createZip(
  [
    { name: "session.json", content: JSON.stringify({ hello: "мир" }) },
    { name: "session.md", content: "# Заголовок\n\nтекст" },
  ],
  new Date("2026-09-25T12:00:00Z"),
);

// Local file header signature.
assert.equal(zip.readUInt32LE(0), 0x04034b50, "должна быть сигнатура локального заголовка");
// End of central directory signature (last 22 bytes).
assert.equal(
  zip.readUInt32LE(zip.length - 22),
  0x06054b50,
  "должна быть сигнатура конца центрального каталога",
);
assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2, "в архиве две записи");

const text = zip.toString("latin1");
assert.ok(text.includes("session.json"), "имя session.json внутри архива");
assert.ok(text.includes("session.md"), "имя session.md внутри архива");

// Содержимое в методе store лежит как есть.
assert.ok(zip.includes(Buffer.from(JSON.stringify({ hello: "мир" }), "utf8")));

console.log("zip tests passed");
