import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

const root = resolve('.');

// Full-repo recursive walk (codex 终审 #F5): the old version only scanned a hand-picked list of
// top-level dirs/files, so anything living outside that allowlist (e.g. this repo's own
// gateway/, test/ dirs, or frontend/package.json) never got checked at all. Now everything under
// root is walked; the only things carved out below are build output / vendor code / VCS
// internals that are either regenerated, gitignored, or too large to be worth reading.
const skipDirNames = new Set(['node_modules', '.git', '.wrangler', 'dist', 'out', '.next']);
// The .tmp-* family are scratch dirs migrations/wrangler leave behind (see .gitignore's
// `.tmp-*/`) — matched by prefix since the suffix varies (.tmp-migration, .tmp-migration2, ...).
const skipDirPrefixes = ['.tmp-'];
// Lockfiles are huge generated dependency graphs, not hand-written source — skip by exact
// basename (matches at any depth, so both the root and frontend/ lockfiles are covered).
const skipFileNames = new Set(['package-lock.json']);
// Binary/opaque extensions: deny-list, not allow-list — a full-repo walk should default to
// scanning any text file it meets (config, docs, scripts, whatever extension), only skipping the
// handful of formats we know never carry reviewable text.
const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tar', '.7z', '.rar',
  '.pdf', '.mp3', '.mp4', '.mov', '.avi', '.wasm',
  '.db', '.sqlite', '.sqlite3',
  '.node', '.exe', '.dll', '.so', '.dylib',
  '.pyc', '.class', '.jar',
]);

// Every CJK needle below is built via String.fromCharCode from numeric code points (never a real
// character pasted into this file), and every ASCII needle is built from split string fragments —
// this file lives under scripts/ and is itself part of the full-repo walk, so a needle spelled
// out contiguously as real characters in this source would make the scanner flag itself.
// fromCharCode's on-disk source is plain ASCII digits, not the character it produces at runtime,
// so even the standalone single-character rule (0x67d2) stays self-safe this way.
const cjk = (...codePoints) => String.fromCharCode(...codePoints);
const forbidden = [
  ['private name', cjk(0x963f, 0x65e5)],
  ['private name (companion)', cjk(0x963f, 0x67d2)],
  ['private project name', cjk(0x67d2, 0x65e5)],
  ['private project name (short)', cjk(0x67d2)],
  ['private companion name (pinyin)', 'yun' + 'bao'],
  ['private companion name', cjk(0x4e91, 0x5b9d)],
  ['private product name', 'Toy' + 'Box'],
  ['private product name', 'Star' + 'Rail'],
  ['old brand', 'seven' + 'day'],
  ['private brand (alt host)', 'ayber' + 'ri'],
  ['private path segment', 'kou' + 'dai'],
  ['private gateway domain (prefix)', 'chat.' + 'seven' + 'day'],
  ['private gateway domain', 'chat.' + 'seven' + 'day-kou' + 'dai.cc'],
  ['known private host', '45.' + '76.'],
];
// The two short ASCII nicknames below are common substrings of ordinary English/pinyin words —
// plain substring matching on them would drown findings in false positives, so these two get
// whole-word matching (word-boundary regex) instead of the plain .includes() the rest of
// `forbidden` uses. Neither the terms nor their labels are spelled out as a bounded word anywhere
// in this comment block on purpose — this file's own text is itself scanned, and a bounded
// occurrence right here would self-match.
const wholeWordTerms = [
  ['private short nickname A (ASCII)', 'ar' + 'i'],
  ['private short nickname B (ASCII)', 'q' + 'i'],
];
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const forbiddenFiles = [/^\.env(?:\.|$)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.lnk$/i];
// Committed-on-purpose placeholder env files (no real secrets, just documented dummy values) —
// exempt these specific names from the .env sweep above instead of loosening the pattern itself.
const allowedEnvTemplateNames = new Set(['.env.example', '.env.sample', '.env.template']);
// Confirmed-legit hits get parked here instead of deleting the word that found them — each entry
// is an exact `relative/path: label` string, kept narrow on purpose (see report for what's here
// and why).
const allowlist = new Set([]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirNames.has(entry.name) || skipDirPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
      files.push(...await walk(resolve(directory, entry.name)));
    } else if (entry.isFile()) {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

const files = await walk(root);

const findings = [];
function report(item) {
  if (allowlist.has(item)) return;
  findings.push(item);
}

for (const path of files) {
  const name = relative(root, path).replaceAll('\\', '/');
  const baseName = name.split('/').at(-1);
  if (!allowedEnvTemplateNames.has(baseName) && forbiddenFiles.some((pattern) => pattern.test(baseName))) {
    report(`${name}: forbidden file type`);
  }
  if (skipFileNames.has(baseName)) continue;
  if (binaryExtensions.has(extname(path).toLowerCase())) continue;
  const text = await readFile(path, 'utf8');
  const lower = text.toLowerCase();
  for (const [label, needle] of forbidden) if (lower.includes(needle.toLowerCase())) report(`${name}: ${label}`);
  for (const [label, term] of wholeWordTerms) {
    if (new RegExp(`\\b${term}\\b`, 'i').test(text)) report(`${name}: ${label}`);
  }
  for (const [label, pattern] of secretPatterns) if (pattern.test(text)) report(`${name}: ${label}`);
}

if (findings.length) {
  console.error(`Release hygiene failed:\n${findings.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Release hygiene passed (${files.length} files scanned).`);
}
