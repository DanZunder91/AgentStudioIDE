#!/bin/sh
# ═════════════════════════════════════════════════════════════════════════════
#  DynamoDB Local seed — Agent Studio database-client fixture
#
#  Runs as a ONE-SHOT sidecar (compose service `dynamodb-seed`), not as an
#  entrypoint: `amazon/dynamodb-local`'s image is a JRE with no shell tooling
#  worth scripting, and its own entrypoint is the server. So the server stays
#  stock and this container talks to it over HTTP with `curl`.
#
#  🔴 Why plain `curl` and not the AWS CLI: DynamoDB Local **does not verify
#  signatures** — it accepts any credentials — so a signed request is not needed
#  to seed it, and pulling the ~400 MB `aws-cli` image to sign requests nothing
#  checks would be cost for nothing. That same fact is why `dynamodb.rs`'s SigV4
#  is pinned against AWS's PUBLISHED VECTORS instead of against this container:
#  a green request here proves the shape, never the signature.
#
#  The marker table `fixture_seeded` is created LAST, and the healthcheck tests
#  for it — so "healthy" cannot mean "half-seeded", exactly as elsewhere.
#  TEST FIXTURE ONLY.
# ═════════════════════════════════════════════════════════════════════════════
set -eu

ENDPOINT="http://dynamodb:8000"
# DynamoDB Local ignores these entirely; they exist so the header is well-formed.
AUTH="AWS4-HMAC-SHA256 Credential=fixture/20260730/eu-west-1/dynamodb/aws4_request, SignedHeaders=host, Signature=00"

call() {
  target="$1"
  body="$2"
  curl -sS -f -X POST "$ENDPOINT/" \
    -H "content-type: application/x-amz-json-1.0" \
    -H "x-amz-target: DynamoDB_20120810.$target" \
    -H "authorization: $AUTH" \
    -d "$body" > /dev/null
}

# Wait for the server's port. `ListTables` is the cheapest real request.
i=0
until curl -sS -o /dev/null -X POST "$ENDPOINT/" \
  -H "content-type: application/x-amz-json-1.0" \
  -H "x-amz-target: DynamoDB_20120810.ListTables" \
  -H "authorization: $AUTH" -d '{}'; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "dynamodb-local never answered" >&2; exit 1; }
  sleep 1
done

# ── tracks: a partition key + sort key table, mirroring the SQL fixtures' shape ──
call CreateTable '{
  "TableName": "tracks",
  "AttributeDefinitions": [
    { "AttributeName": "title",  "AttributeType": "S" },
    { "AttributeName": "ts",     "AttributeType": "N" },
    { "AttributeName": "studio", "AttributeType": "S" }
  ],
  "KeySchema": [
    { "AttributeName": "title", "KeyType": "HASH" },
    { "AttributeName": "ts",    "KeyType": "RANGE" }
  ],
  "GlobalSecondaryIndexes": [{
    "IndexName": "by-studio",
    "KeySchema": [{ "AttributeName": "studio", "KeyType": "HASH" }],
    "Projection": { "ProjectionType": "ALL" }
  }],
  "BillingMode": "PAY_PER_REQUEST"
}'

# Four items, chosen so every cell state the contract can hold is exercised:
#   1  every attribute present
#   2  `tag` explicitly NULL           → the NULL cell
#   3  `tag` the EMPTY STRING          → distinct from NULL
#   4  `tag` ABSENT ENTIRELY           → the third state the contract cannot hold,
#                                        which the result's notice must name
# `duration` carries 38 significant digits on item 1: a DynamoDB number that no f64
# can represent, so a client that parsed it to re-render it would corrupt the value.
call PutItem '{ "TableName": "tracks", "Item": {
  "title": {"S": "Amberline"}, "ts": {"N": "1"},
  "duration": {"N": "12345678901234567890123456789012345678"},
  "studio": {"S": "harbor"}, "tag": {"S": "first"},
  "ok": {"BOOL": true}, "tags": {"SS": ["a", "b"]},
  "meta": {"M": {"gain": {"N": "0.25"}}}
}}'
call PutItem '{ "TableName": "tracks", "Item": {
  "title": {"S": "Bluewater"}, "ts": {"N": "2"},
  "duration": {"N": "0.5000"}, "studio": {"S": "harbor"}, "tag": {"NULL": true}
}}'
call PutItem '{ "TableName": "tracks", "Item": {
  "title": {"S": "Cinderglass"}, "ts": {"N": "3"},
  "duration": {"N": "1.25"}, "studio": {"S": "central"}, "tag": {"S": ""}
}}'
call PutItem '{ "TableName": "tracks", "Item": {
  "title": {"S": "Driftwood"}, "ts": {"N": "4"},
  "duration": {"N": "9"}, "studio": {"S": "central"}
}}'

# ── studios: deliberately EMPTY, so a write probe has somewhere to go that does not
#    disturb the seeded rows (the Mongo fixture's `studios` serves the same purpose) ──
call CreateTable '{
  "TableName": "studios",
  "AttributeDefinitions": [{ "AttributeName": "name", "AttributeType": "S" }],
  "KeySchema": [{ "AttributeName": "name", "KeyType": "HASH" }],
  "BillingMode": "PAY_PER_REQUEST"
}'

# ── the marker, LAST ──
call CreateTable '{
  "TableName": "fixture_seeded",
  "AttributeDefinitions": [{ "AttributeName": "id", "AttributeType": "S" }],
  "KeySchema": [{ "AttributeName": "id", "KeyType": "HASH" }],
  "BillingMode": "PAY_PER_REQUEST"
}'

echo "dynamodb fixture seeded"
