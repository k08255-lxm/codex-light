import test from "node:test";
import assert from "node:assert/strict";
import { validateAttachmentMetadata as validate } from "../src/attachment-policy.mjs";

const MAX_SIZE = 20 * 1024 * 1024;
const BASE = Object.freeze({ name: "report.txt", size: 0, mime: "text/plain" });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Full expected result; riskWarning is true exactly for archive and unknown. */
const expected = (name, mime, category, size = 1) => ({
  name,
  size,
  mime,
  category,
  riskWarning: category === "archive" || category === "unknown",
});
const expectCategory = (name, mime, category) =>
  assert.deepEqual(validate({ name, size: 1, mime }), expected(name, mime, category), `${name} + ${mime}`);
const rejects = (overrides) =>
  assert.throws(() => validate({ ...BASE, size: 1, ...overrides }), TypeError, String(Object.values(overrides)[0]));

/** Rebuild BASE with one field replaced by a custom property descriptor. */
function withDescriptor(field, descriptor) {
  const metadata = {};
  for (const [key, value] of Object.entries(BASE)) {
    if (key === field) Object.defineProperty(metadata, key, { configurable: true, ...descriptor });
    else metadata[key] = value;
  }
  return metadata;
}

test("classifies every supported extension and documented MIME alias", () => {
  const cases = [
    ["txt", "text/plain", "text"], ["md", "text/markdown", "text"], ["md", "text/x-markdown", "text"], ["csv", "text/csv", "text"],
    ["py", "text/x-python", "code"], ["py", "application/x-python", "code"], ["rs", "text/x-rust", "code"], ["rs", "application/x-rust", "code"],
    ["go", "text/x-go", "code"], ["c", "text/x-c", "code"], ["h", "text/x-chdr", "code"], ["h", "text/x-c", "code"],
    ["cpp", "text/x-c++", "code"], ["cpp", "text/x-cpp", "code"], ["java", "text/x-java-source", "code"], ["java", "text/x-java", "code"],
    ["css", "text/css", "code"], ["html", "text/html", "code"], ["json", "application/json", "code"], ["json", "text/json", "code"],
    ["toml", "application/toml", "code"], ["toml", "text/x-toml", "code"], ["yaml", "application/yaml", "code"], ["yaml", "application/x-yaml", "code"],
    ["yml", "text/x-yaml", "code"], ["yml", "text/yaml", "code"], ["pdf", "application/pdf", "pdf"],
    ["doc", "application/msword", "office"], ["docx", DOCX, "office"], ["xls", "application/vnd.ms-excel", "office"], ["xlsx", XLSX, "office"],
    ["ppt", "application/vnd.ms-powerpoint", "office"], ["pptx", PPTX, "office"],
    ["zip", "application/zip", "archive"], ["zip", "application/x-zip-compressed", "archive"], ["7z", "application/x-7z-compressed", "archive"],
    ["tar", "application/x-tar", "archive"], ["gz", "application/gzip", "archive"], ["gz", "application/x-gzip", "archive"],
  ];
  for (const [extension, mime, category] of cases) expectCategory(`sample.${extension}`, mime, category);
});

test("extension and MIME matching is case-insensitive and ignores MIME parameters", () => {
  expectCategory("REPORT.PDF", "Application/PDF; charset=binary", "pdf");
  expectCategory("NOTES.MD", "TEXT/MARKDOWN;charset=UTF-8", "text");
  expectCategory("DATA.JSON", "Application/JSON ; profile=example", "code");
});

test("unknown extensions, missing proof and conflicting MIME pairs are unknown with a risk warning", () => {
  const cases = [
    ["report.txt", ""], ["report.pdf", "application/octet-stream"], ["notes.txt", "application/x-msdownload"],
    ["payload.bin", "application/octet-stream"], ["photo.png", "image/png"], ["archive.rar", "application/vnd.rar"],
    ["README", "text/plain"], ["report.", "application/pdf"], ["file.unknown", "text/plain"],
    ["report.txt", "application/pdf"], ["document.pdf", "text/plain"], ["bundle.zip", "application/pdf"],
    ["document.docx", "application/msword"], ["document.xls", XLSX], ["notes.csv", "text/plain"],
    ["page.html", "application/json"], ["source.py", "text/x-rust"],
  ];
  for (const [name, mime] of cases) expectCategory(name, mime, "unknown");
});

test("rejects blocked executable extensions in any case or hidden by trailing dots and spaces", () => {
  for (const extension of ["exe", "dll", "msi", "bat", "cmd", "ps1", "sh", "scr", "js", "mjs", "cjs", "vbs", "lnk"]) {
    rejects({ name: `upload.${extension}` });
    rejects({ name: `upload.${extension.toUpperCase()}`, mime: "application/octet-stream" });
  }
  for (const name of ["setup.exe.", "setup.exe ", "setup.exe .", "SETUP.EXE.. "]) rejects({ name });
});

test("rejects unsafe names: dot segments, separators, drives, streams and control characters", () => {
  const unsafe = [
    ".", "..", "../secret.txt", "..\\secret.txt", "folder/file.txt", "folder\\file.txt", "/etc/passwd",
    "\\server\\share\\file.txt", "C:\\temp\\file.txt", "C:relative.txt", "file.txt:stream", "\\\\server\\share\\file.txt",
    ...["\u0000", "\u0001", "\u0008", "\u0009", "\u000a", "\u000d", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f"].map((c) => `report${c}.txt`),
  ];
  for (const name of unsafe) rejects({ name });
});

test("enforces name, size and MIME type and length boundaries without normalizing safe names", () => {
  const maxName = `${"a".repeat(251)}.txt`;
  assert.equal(maxName.length, 255);
  assert.equal(validate({ ...BASE, name: maxName }).name, maxName);
  const spaced = "Quarterly Report (final).txt";
  assert.equal(validate({ ...BASE, name: spaced }).name, spaced);
  for (const name of [`${maxName}x`, "", 42, null]) rejects({ name });

  for (const size of [0, 1, MAX_SIZE]) assert.equal(validate({ ...BASE, size }).size, size);
  for (const size of [-1, MAX_SIZE + 1, 0.5, 1.25, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", 1n, null]) rejects({ size });

  assert.equal(validate({ ...BASE, mime: "x".repeat(128) }).category, "unknown");
  for (const mime of ["x".repeat(129), 123, "text/plain\u0000", "text/plain\n"]) rejects({ mime });
});

test("rejects non-plain inputs, missing or extra fields, inherited/accessor/hidden properties", () => {
  const inherited = Object.assign(Object.create({ extra: true }), BASE);
  const hiddenExtra = Object.defineProperty({ ...BASE }, "extra", { enumerable: false, value: true });
  const invalid = [
    null, undefined, "metadata", 1, true, [], new Date(),
    { name: "report.txt", size: 1 }, { name: "report.txt", mime: "text/plain" }, { size: 1, mime: "text/plain" }, {},
    { ...BASE, extra: true }, { ...BASE, [Symbol("extra")]: true }, inherited, hiddenExtra,
    ...["name", "size", "mime"].map((field) => withDescriptor(field, { value: BASE[field], enumerable: false, writable: true })),
  ];
  for (const value of invalid) assert.throws(() => validate(value), TypeError);
});

test("rejects accessor fields without invoking their getters", () => {
  for (const field of ["name", "size", "mime"]) {
    let invoked = false;
    const sentinel = new Error(`${field} getter was invoked`);
    const metadata = withDescriptor(field, { enumerable: true, get() { invoked = true; throw sentinel; } });
    assert.throws(() => validate(metadata), (error) => error instanceof TypeError && error !== sentinel, field);
    assert.equal(invoked, false, field);
  }
});

test("accepts frozen and null-prototype objects and returns a fresh plain record of five fields", () => {
  const plain = Object.freeze({ ...BASE });
  const nullPrototype = Object.assign(Object.create(null), BASE);
  for (const input of [plain, nullPrototype]) {
    const result = validate(input);
    assert.deepEqual(result, expected("report.txt", "text/plain", "text", 0));
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  }
  assert.deepEqual(plain, BASE);
});
