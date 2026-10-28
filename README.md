Internal tool to upload to S3. Uses `~/.abc-credentials`.

## Usage

```
Usage: s3-upload [options]

Options:
  -e, --end-point <server>      S3 endpoint, e.g. sgp1.digitaloceanspaces.com
  -p, --port <port>             Port to connect over
  -a, --access-key <accessKey>  s3 access key
  -k, --secret-key <secretKey>  s3 secret key
  -b, --bucket <bucket>         Bucket to put files in
  --profile <name>              Profile to read from ~/.abc-credentials (default: "newsDigitalSpace")
  -s, --src <srcDir>            source directory to publish (default: "dist/")
  -d, --dest <destDir>          directory on the S3 server to publish to
  -m, --max-age <rules>         Cache max-age as semicolon-separated "glob:duration" rules, e.g.
                                'aus.json:365days;*:20min'. Durations use the 'ms' format. see
                                https://www.npmjs.com/package/ms Files matching no rule get 10m.
  -c, --compress <globs>        Semicolon-separated globs of files to brotli-compress, e.g.
                                '*.json;data/*.csv'. Files under 1024 bytes are never compressed.
                                Default: '*.json;*.xml;*.csv'.
  --no-compress                 Disable brotli compression entirely
  -h, --help                    display help for command
```

Defaults for `endPoint`, `port`, `accessKey`, `secretKey`, `bucket`, `maxAge` and `compress` are read from
`~/.abc-credentials` (if it exists). Command line options take precedence.

## Behaviour

### Uploads

Every file under `--src` is uploaded, except dotfiles and dot directories (anything whose name starts
with `.`, such as `.DS_Store` or `.git`), which are skipped. Files are uploaded to `--dest` with `putObject` (up to 10 at a time), preserving
the directory structure, with the `public-read` ACL. The `Content-Type` is inferred from
each file's name. If one upload fails, no further uploads are started and the process exits with an
error.

### Cache control

Each file gets a `cache-control: max-age=<seconds>` header. `--max-age` takes semicolon-separated
`glob:duration` rules, and the first matching rule wins. Globs without a `/` match the file name only.
A bare duration (no glob) applies to every file. Files matching no rule get `10m`.

### Compression

Files matching a `--compress` glob are brotli-compressed (quality 11) and uploaded with
`Content-Encoding: br`, keeping their original `Content-Type`. A file is only uploaded compressed if
the result is actually smaller, and files under 1 KB are never compressed. The default globs cover
text formats (`*.json`, `*.xml`, `*.csv`); images, fonts and video are already compressed, so leave
them out. Use `--no-compress` (or `"compress": false` in the credentials file) to turn compression off.

## Credentials format

```json
{
  "newsDigitalSpace": {
    "type": "s3",
    "endPoint": "sgp1.digitaloceanspaces.com",
    "port": 443,
    "accessKey": "x",
    "secretKey": "y",
    "bucket": "abcnewsdata",
    "maxAge": "aus.json:365days;*:20min",
    "compress": "*.json;*.xml;*.csv"
  }
}
```

`maxAge` and `compress` are optional.
