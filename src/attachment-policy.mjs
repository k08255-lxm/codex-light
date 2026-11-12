const MAX_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 128;
const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB
const ALLOWED_FIELDS = new Set(["name", "size", "mime"]);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

// Extensions are compared in lower case. The list is intentionally exact:
// this module does not try to execute, unpack, or inspect the attachment.
const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "msi",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "scr",
  "js",
  "mjs",
  "cjs",
  "vbs",
  "lnk",
]);

function rule(category, ...mimeTypes) {
  return Object.freeze({
    category,
    mimeTypes: new Set(mimeTypes),
  });
}

// A known extension is emitted only when the declared MIME type is in the
// extension's explicit compatibility set. Generic or absent MIME types do
// not prove a format and therefore produce "unknown".
const EXTENSION_RULES = new Map([
  ["txt", rule("text", "text/plain")],
  ["md", rule("text", "text/markdown", "text/x-markdown")],
  ["csv", rule("text", "text/csv")],

  ["py", rule("code", "text/x-python", "application/x-python")],
  ["rs", rule("code", "text/x-rust", "application/x-rust")],
  ["go", rule("code", "text/x-go")],
  ["c", rule("code", "text/x-c")],
  ["h", rule("code", "text/x-c", "text/x-chdr")],
  ["cpp", rule("code", "text/x-c++", "text/x-cpp")],
  ["java", rule("code", "text/x-java", "text/x-java-source")],
  ["css", rule("code", "text/css")],
  ["html", rule("code", "text/html")],
  ["json", rule("code", "application/json", "text/json")],
  ["toml", rule("code", "application/toml", "text/x-toml")],
  ["yaml", rule("code", "application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml")],
  ["yml", rule("code", "application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml")],

  ["pdf", rule("pdf", "application/pdf")],

  ["doc", rule("office", "application/msword")],
  [
    "docx",
    rule(
      "office",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
  ],
  ["xls", rule("office", "application/vnd.ms-excel")],
  [
    "xlsx",
    rule(
      "office",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  ],
  ["ppt", rule("office", "application/vnd.ms-powerpoint")],
  [
    "pptx",
    rule(
      "office",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
  ],

  ["zip", rule("archive", "application/zip", "application/x-zip-compressed")],
  ["7z", rule("archive", "application/x-7z-compressed")],
  ["tar", rule("archive", "application/x-tar")],
  ["gz", rule("archive", "application/gzip", "application/x-gzip")],
]);

function fail(message) {
  throw new TypeError(message);
}

function readInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("Attachment metadata must be a plain object.");
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("Attachment metadata must be a plain object.");
  }

  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);

  if (keys.length !== ALLOWED_FIELDS.size) {
    fail("Attachment metadata must contain exactly name, size, and mime.");
  }

  for (const key of keys) {
    if (typeof key !== "string" || !ALLOWED_FIELDS.has(key)) {
      fail("Attachment metadata contains an unknown field.");
    }
  }

  const values = {};
  for (const key of ALLOWED_FIELDS) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail(
        `Attachment metadata field "${key}" must be an enumerable own data property.`,
      );
    }
    values[key] = descriptor.value;
  }

  return values;
}

function validateName(name) {
  if (typeof name !== "string") {
    fail("Attachment name must be a string.");
  }
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    fail(`Attachment name must be 1-${MAX_NAME_LENGTH} characters.`);
  }
  if (name === "." || name === "..") {
    fail("Attachment name must not be a dot path segment.");
  }
  if (name.includes("/") || name.includes("\\") || name.includes(":")) {
    fail("Attachment name must not contain path separators or a drive/stream colon.");
  }
  if (CONTROL_CHARACTERS.test(name)) {
    fail("Attachment name must not contain control characters.");
  }
  if (hasBlockedExecutableExtension(name)) {
    fail("Attachment name has a blocked executable extension.");
  }
}

function hasBlockedExecutableExtension(name) {
  // Dropping trailing spaces and dots prevents Windows-normalized names such
  // as "setup.exe." and "setup.exe " from slipping past the extension check.
  const candidate = name.replace(/[ .]+$/u, "");
  const lastDot = candidate.lastIndexOf(".");
  if (lastDot === -1) {
    return false;
  }
  const extension = candidate.slice(lastDot + 1).toLowerCase();
  return BLOCKED_EXECUTABLE_EXTENSIONS.has(extension);
}

function validateSize(size) {
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_SIZE_BYTES
  ) {
    fail(`Attachment size must be an integer from 0 to ${MAX_SIZE_BYTES}.`);
  }
}

function validateMime(mime) {
  if (typeof mime !== "string") {
    fail("Attachment MIME type must be a string.");
  }
  if (mime.length > MAX_MIME_LENGTH) {
    fail(`Attachment MIME type must be at most ${MAX_MIME_LENGTH} characters.`);
  }
  if (CONTROL_CHARACTERS.test(mime)) {
    fail("Attachment MIME type must not contain control characters.");
  }
}

function extensionOf(name) {
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  return name.slice(lastDot + 1).toLowerCase();
}

function normalizeMime(mime) {
  const semicolon = mime.indexOf(";");
  const mediaType = semicolon === -1 ? mime : mime.slice(0, semicolon);
  return mediaType.trim().toLowerCase();
}

function classify(name, mime) {
  const ruleForExtension = EXTENSION_RULES.get(extensionOf(name));
  if (!ruleForExtension) {
    return "unknown";
  }
  return ruleForExtension.mimeTypes.has(normalizeMime(mime))
    ? ruleForExtension.category
    : "unknown";
}

/**
 * Validate non-image attachment metadata without reading attachment content.
 *
 * @param {{name: string, size: number, mime: string}} input
 * @returns {{name: string, size: number, mime: string, category: string, riskWarning: boolean}}
 * @throws {TypeError} If the structure or any field is invalid or unsafe.
 */
export function validateAttachmentMetadata(input) {
  const metadata = readInput(input);
  validateName(metadata.name);
  validateSize(metadata.size);
  validateMime(metadata.mime);

  const category = classify(metadata.name, metadata.mime);

  return {
    name: metadata.name,
    size: metadata.size,
    mime: metadata.mime,
    category,
    riskWarning: category === "archive" || category === "unknown",
  };
}
