Internal tool to upload to S3. Uses .aunty-credentials.

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
  -m, --max-age <rules>         Cache max-age as semicolon-separated "glob:duration" rules, e.g. 'aus.json:365days;*:20min'. Durations use the 'ms' format. see
                                https://www.npmjs.com/package/msFiles matching no rule get 10m.
  -h, --help                    display help for command
```

Defaults for `endPoint`, `port`, `accessKey`, `secretKey`, `bucket` and `maxAge` are read from
`~/.abc-credentials` (if it exists). Command line options take precedence.

## Credentials format

```json
{
  "newsDigitalSpace": {
    "type": "s3",
    "endPoint": "sgp1.digitaloceanspaces.com",
    "port": 443,
    "accessKey": "x",
    "secretKey": "y",
    "bucket": "abcnewsdata"
  }
}
```
