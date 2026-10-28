import * as Minio from "minio";
import fs from "fs/promises";
import { createReadStream } from "fs";
import os from "os";
import process from "process";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import mime from "mime";
import async from "async";
import ms from "ms";
import { minimatch } from "minimatch";
import { program } from "commander";

const CREDENTIALS_FILE = path.join(os.homedir(), ".abc-credentials");
const DEFAULT_PROFILE = "newsDigitalSpace";
const DEFAULT_PORT = 443;
const UPLOAD_CONCURRENCY = 10;
const SECRET_KEYS = ["accessKey", "secretKey"];
const DEFAULT_MAX_AGE = "10m";

// Brotli compression. The default globs match the extensions compressed by the
// reference upload-s3.mjs (json, xml, csv). Images, fonts, video etc. are
// already compressed, so only add text-like formats here.
const DEFAULT_COMPRESS = "*.json;*.xml;*.csv";
const MIN_COMPRESS_BYTES = 1024; // never compress anything under 1 KB
const BROTLI_QUALITY = 11; // 0-11; 11 gives the smallest output

const brotliCompress = promisify(zlib.brotliCompress);

/** Prefix for every log line, so output is consistent and sortable. */
const timestamp = () => `[${new Date().toISOString()}]`;
const log = (...args) => console.log(timestamp(), ...args);
const logError = (...args) => console.error(timestamp(), ...args);

// Required options are validated in go() after merging in ~/.abc-credentials,
// so they are declared as plain options here.
program
  .option(
    "-e, --end-point <server>",
    "S3 endpoint, e.g. sgp1.digitaloceanspaces.com",
  )
  .option("-p, --port <port>", "Port to connect over")
  .option("-a, --access-key <accessKey>", "s3 access key")
  .option("-k, --secret-key <secretKey>", "s3 secret key")
  .option("-b, --bucket <bucket>", "Bucket to put files in")
  .option(
    "--profile <name>",
    `Profile to read from ${CREDENTIALS_FILE}`,
    DEFAULT_PROFILE,
  )
  .requiredOption("-s, --src <srcDir>", "source directory to publish", "dist/")
  .requiredOption(
    "-d, --dest <destDir>",
    "directory on the S3 server to publish to",
  )
  .option(
    "-m, --max-age <rules>",
    `Cache max-age as semicolon-separated "glob:duration" rules, e.g. 'aus.json:365days;*:20min'. ` +
      `Durations use the 'ms' format. see https://www.npmjs.com/package/ms ` +
      `Files matching no rule get ${DEFAULT_MAX_AGE}.`,
  )
  .option(
    "-c, --compress <globs>",
    `Semicolon-separated globs of files to brotli-compress, e.g. '*.json;data/*.csv'. ` +
      `Files under ${MIN_COMPRESS_BYTES} bytes are never compressed. ` +
      `Default: '${DEFAULT_COMPRESS}'.`,
  )
  .option("--no-compress", "Disable brotli compression entirely")
  .addHelpText(
    "after",
    `
Defaults for endPoint, port, accessKey, secretKey, bucket, maxAge and compress are read from
${CREDENTIALS_FILE} (if it exists). Command line options take precedence.
Compressed files are uploaded with "Content-Encoding: br" and keep their original Content-Type.`,
  );

program.parse();

/**
 * Load a profile from ~/.abc-credentials, if the file exists.
 * @param {string} profile - Key within the credentials file
 * @returns Object with any of endPoint, port, accessKey, secretKey, bucket
 **/
async function loadCredentialDefaults(profile) {
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, "utf8");
    const creds = JSON.parse(raw);
    const entry = creds[profile];
    if (!entry) {
      return {};
    }
    return entry;
  } catch (e) {
    throw new Error(`${CREDENTIALS_FILE} is not valid JSON: ${e.message}`);
  }
}

/**
 * Copy of the options that is safe to print: credentials are masked.
 * @param {object} opts
 * @returns Object with secrets replaced by "***"
 **/
function redact(opts) {
  const safe = { ...opts };
  SECRET_KEYS.forEach((key) => {
    if (safe[key]) safe[key] = "***";
  });
  return safe;
}

/**
 * Convert a duration string (ms format, e.g. "20min", "365days") to whole seconds.
 * @param {string} duration
 * @returns {number} Seconds, or throws if the duration is invalid/negative
 **/
function durationToSeconds(duration) {
  let millis;
  try {
    millis = ms(duration);
  } catch {
    millis = undefined;
  }
  if (typeof millis !== "number" || !Number.isFinite(millis) || millis < 0) {
    throw new Error(`Invalid duration "${duration}"`);
  }
  return Math.floor(millis / 1000);
}

/**
 * Parse a max-age spec such as 'aus.json:365days;*:20min' into ordered rules.
 * @param {string} spec - Semicolon-separated "glob:duration" rules
 * @returns Array of { pattern, seconds }
 **/
function parseMaxAgeRules(spec) {
  return String(spec)
    .split(";")
    .map((rule) => rule.trim())
    .filter(Boolean)
    .map((rule) => {
      const split = rule.lastIndexOf(":");
      // A rule with no ":" is a bare duration that applies to everything
      const pattern = split === -1 ? "*" : rule.slice(0, split).trim();
      const duration = (split === -1 ? rule : rule.slice(split + 1)).trim();
      if (!pattern) {
        throw new Error(`Invalid --max-age rule "${rule}": empty glob`);
      }
      try {
        return { pattern, seconds: durationToSeconds(duration) };
      } catch (e) {
        throw new Error(`Invalid --max-age rule "${rule}": ${e.message}`);
      }
    });
}

/**
 * Find the max-age (in seconds) for a file. The first matching rule wins.
 * @param {string} relativePath - Path relative to the source dir, "/" separated
 * @param {Array} rules - Output of parseMaxAgeRules
 * @param {number} fallback - Seconds to use if no rule matches
 **/
function maxAgeFor(relativePath, rules, fallback) {
  // matchBase: patterns without a "/" are matched against the file name only
  const rule = rules.find((r) =>
    minimatch(relativePath, r.pattern, { matchBase: true, dot: true }),
  );
  return rule ? rule.seconds : fallback;
}

/**
 * Parse a semicolon-separated list of globs, e.g. '*.json;*.csv'.
 * @param {string} spec
 * @returns {string[]} Non-empty, trimmed globs
 **/
function parseGlobList(spec) {
  return String(spec)
    .split(";")
    .map((g) => g.trim())
    .filter(Boolean);
}

/**
 * Should this file be brotli-compressed?
 * @param {string} relativePath - Path relative to the source dir, "/" separated
 * @param {number} size - File size in bytes
 * @param {string[]} globs - Compress patterns (empty = compression disabled)
 **/
function shouldCompress(relativePath, size, globs) {
  if (size < MIN_COMPRESS_BYTES) return false;
  return globs.some((g) =>
    minimatch(relativePath, g, { matchBase: true, dot: true }),
  );
}

/**
 * Recursively list directories to create an array of src/dest files to upload.
 * Dotfiles and dot directories (names starting with ".") are skipped.
 * @param {string} src - Source directory, an absolute path
 * @param {string} dest - Dest dir on the s3 server
 * @returns Array of objects with local & remote filenames
 **/
async function syncDir({ src, dest }) {
  const listing = await fs.readdir(src, { withFileTypes: true });
  const files = [];
  const dirs = [];
  listing.forEach((entry) => {
    // Skip dotfiles and dot directories (.DS_Store, .git, .env, ...)
    if (entry.name.startsWith(".")) return;
    if (entry.isDirectory()) {
      dirs.push(entry.name + "/");
    } else {
      files.push({
        local: path.join(entry.parentPath, entry.name),
        remote: path.join(dest, entry.name),
      });
    }
  });
  const extraFiles = await Promise.all(
    dirs.map((dir) =>
      syncDir({
        src: path.join(src, dir),
        dest: path.join(dest, dir),
      }),
    ),
  );
  extraFiles.forEach((newFiles) => {
    files.push(...newFiles);
  });
  return files;
}

/**
 * Upload a single file with putObject, brotli-compressing it first if it
 * matches the compress globs and the compressed copy is actually smaller.
 * Uncompressed files are streamed from disk rather than read into memory.
 * @param {object} params
 * @param {Minio.Client} params.client - Configured minio client
 * @param {string} params.bucket - Destination bucket
 * @param {string} params.local - Absolute local path
 * @param {string} params.remote - Object key on the S3 server
 * @param {string} params.relative - Path relative to the source dir, "/" separated
 * @param {object} [params.metadata] - Extra object metadata/headers (cache-control, x-amz-acl, ...).
 *   Content-Type is inferred from the file name; Content-Encoding is set when compressed.
 * @param {string[]} params.compressGlobs - Compress patterns (empty = compression disabled)
 * @returns {Promise<string>} Note describing any compression, e.g. ", br 2048B -> 512B" (empty if none)
 **/
async function putFile({
  client,
  bucket,
  local,
  remote,
  relative,
  metadata = {},
  compressGlobs,
}) {
  const { size } = await fs.stat(local);
  const headers = { ...metadata };
  const contentType = mime.getType(local);
  if (contentType) headers["Content-Type"] = contentType;
  let body = null;
  let length = size;
  let note = "";

  if (shouldCompress(relative, size, compressGlobs)) {
    const original = await fs.readFile(local);
    const candidate = await brotliCompress(original, {
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: original.length,
      },
    });
    // Only ship the compressed copy if it's actually smaller
    if (candidate.length < original.length) {
      body = candidate;
      length = candidate.length;
      headers["Content-Encoding"] = "br";
      note = `, br ${original.length}B -> ${candidate.length}B`;
    } else {
      // Already read it, so reuse the buffer instead of re-reading from disk
      body = original;
      length = original.length;
    }
  }

  if (!body) {
    body = createReadStream(local);
  }

  await client.putObject(bucket, remote, body, length, headers);
  return note;
}

async function go() {
  const cli = program.opts();
  const { profile, ...cliOpts } = cli;

  // Precedence: command line > ~/.abc-credentials > built-in default
  const fileDefaults = await loadCredentialDefaults(profile);
  const opts = {
    port: DEFAULT_PORT,
    maxAge: DEFAULT_MAX_AGE,
    compress: DEFAULT_COMPRESS,
    ...fileDefaults,
  };
  for (const [key, value] of Object.entries(cliOpts)) {
    if (value !== undefined) opts[key] = value;
  }

  // Sanity check given options
  const errors = [];
  [
    "bucket",
    "endPoint",
    "port",
    "accessKey",
    "secretKey",
    "src",
    "dest",
  ].forEach((key) => {
    if (!opts[key]) {
      errors.push(`${key} is required`);
    }
  });

  // Parse max-age rules up front so a typo fails before anything is uploaded
  let maxAgeRules = [];
  try {
    maxAgeRules = parseMaxAgeRules(opts.maxAge);
  } catch (e) {
    errors.push(e.message);
  }

  // opts.compress is false for --no-compress (or "compress": false in the
  // credentials file); otherwise it's a semicolon-separated glob list.
  const compressGlobs =
    opts.compress === false ? [] : parseGlobList(opts.compress);

  if (errors.length) {
    log(redact(opts));
    errors.forEach((e) => logError(e));
    throw new Error(
      `Required options were missing or invalid. Pass them as flags or add them to ${CREDENTIALS_FILE}.`,
    );
  }

  // Set up s3 client
  const { src, dest, bucket, maxAge, compress, ...s3Options } = opts;
  s3Options.port = Number(s3Options.port);
  const minioClient = new Minio.Client(s3Options);

  const defaultMaxAge = durationToSeconds(DEFAULT_MAX_AGE);
  const srcAbsolute = path.resolve(process.cwd(), src);
  const actions = await syncDir({ src: srcAbsolute, dest });

  log(
    `Uploading ${actions.length} file(s) to ${bucket}` +
      (compressGlobs.length
        ? ` (brotli: ${compressGlobs.join(", ")}; min ${MIN_COMPRESS_BYTES}B)`
        : " (compression off)"),
  );

  // Transfer files, up to UPLOAD_CONCURRENCY at a time. On the first failure
  // no further uploads are started; in-flight ones are allowed to finish.
  await async.eachLimit(actions, UPLOAD_CONCURRENCY, async (action) => {
    const { local, remote } = action;
    const relative = path
      .relative(srcAbsolute, local)
      .split(path.sep)
      .join("/");
    const fileMaxAge = maxAgeFor(relative, maxAgeRules, defaultMaxAge);
    const metadata = {
      "x-amz-acl": "public-read",
      "cache-control": `max-age=${fileMaxAge}`,
    };
    const started = Date.now();
    try {
      const note = await putFile({
        client: minioClient,
        bucket,
        local,
        remote,
        relative,
        metadata,
        compressGlobs,
      });
      log(`Uploaded ${remote} (${Date.now() - started}ms${note})`);
    } catch (e) {
      logError(`FAILED ${remote}: ${e.message}`);
      throw e;
    }
  });

  log("All uploads complete");
}

go().catch((e) => {
  logError(e);
  process.exit(1);
});
