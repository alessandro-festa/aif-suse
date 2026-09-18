#!/usr/bin/env python3
"""Embed the seed corpus and upsert it into Qdrant.

Runs once, as a Helm post-install Job. Standard library only — no pip at
runtime, so nothing is resolved from the internet while this runs. That is the
same argument the sandbox image makes with its Application Collection
`index-url`, taken one step further: no package index at all.

Idempotent. Point IDs are derived deterministically from the document id, so a
re-run overwrites rather than duplicating, and a failed run can simply be
retried.
"""

import glob
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

QDRANT = os.environ["QDRANT_URL"].rstrip("/")
COLLECTION = os.environ["COLLECTION_NAME"]
VECTOR_SIZE = int(os.environ["VECTOR_SIZE"])
DISTANCE = os.environ.get("DISTANCE", "Cosine")
EMBED_URL = os.environ["EMBEDDING_URL"]
EMBED_MODEL = os.environ["EMBEDDING_MODEL"]
CORPUS_DIR = os.environ.get("CORPUS_DIR", "/corpus")
WAIT_TIMEOUT = float(os.environ.get("WAIT_TIMEOUT_SECONDS", "1500"))

# Stable namespace for point IDs. Qdrant accepts only unsigned integers or
# UUIDs as point IDs, so the human-readable document id becomes a UUID5.
ID_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


def request(method, url, body=None, timeout=120, parse=True):
    """Call the API. `parse=False` for endpoints that do not answer in JSON.

    Qdrant's /readyz is one of them — it returns the bare string
    "all shards are ready". Parsing it raises JSONDecodeError, which wait_for
    reads as "not ready" and retries until the budget runs out, so the Job
    never completes even though Qdrant came up fine. Observed on the first
    install: thirteen recreated Jobs against a healthy Qdrant.
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if not parse:
        return raw
    return json.loads(raw) if raw else {}


def wait_for(name, probe):
    """Poll until `probe` succeeds or the budget runs out.

    The embedding server downloads its GGUF on first start, inside a 20-minute
    startup-probe budget. This Job will therefore find it unavailable for a
    while on a cold cluster. Polling is the expected path, not an error path.
    """
    deadline = time.monotonic() + WAIT_TIMEOUT
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            probe()
            print(f"{name}: ready after {attempt} attempt(s)", flush=True)
            return
        except Exception as exc:  # noqa: BLE001 - any failure means "not yet"
            if attempt == 1 or attempt % 10 == 0:
                print(f"{name}: not ready ({type(exc).__name__}), waiting…", flush=True)
            time.sleep(5)
    raise SystemExit(f"{name}: not ready within {WAIT_TIMEOUT}s — giving up")


def embed(text):
    payload = request(
        "POST", EMBED_URL, {"model": EMBED_MODEL, "input": text}, timeout=300
    )
    vector = payload["data"][0]["embedding"]
    if len(vector) != VECTOR_SIZE:
        # Fail loudly and name the real cause. Qdrant's own error for a wrong
        # vector size reports the number and not the reason, which sends people
        # looking at the collection rather than at the model.
        raise SystemExit(
            f"embedding model {EMBED_MODEL} returned {len(vector)} dimensions but "
            f"collection {COLLECTION} is configured for {VECTOR_SIZE}. "
            f"collection.vectorSize in values.yaml must match the model in "
            f"secops-cpu-inference."
        )
    return vector


def ensure_collection():
    try:
        request("GET", f"{QDRANT}/collections/{COLLECTION}")
        print(f"collection {COLLECTION}: already exists", flush=True)
        return
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
    request(
        "PUT",
        f"{QDRANT}/collections/{COLLECTION}",
        {"vectors": {"size": VECTOR_SIZE, "distance": DISTANCE}},
    )
    print(f"collection {COLLECTION}: created", flush=True)


def main():
    wait_for("qdrant", lambda: request("GET", f"{QDRANT}/readyz", timeout=10, parse=False))
    wait_for("embedding server", lambda: embed("readiness probe"))

    ensure_collection()

    paths = sorted(glob.glob(os.path.join(CORPUS_DIR, "*.json")))
    if not paths:
        raise SystemExit(f"no corpus documents found in {CORPUS_DIR}")

    points = []
    for path in paths:
        with open(path) as fh:
            doc = json.load(fh)
        # Title is prepended to the body before embedding: it carries the CVE id
        # and the package name, which is most of what a researcher's query
        # matches on, and nomic-embed truncates long inputs from the end.
        vector = embed(f"{doc['title']}\n\n{doc['text']}")
        points.append(
            {
                "id": str(uuid.uuid5(ID_NAMESPACE, doc["id"])),
                "vector": vector,
                # The whole document becomes the payload, so every field added
                # in corpus/ shows up in the Qdrant dashboard and in what an
                # agent can cite. That is the point: the human opens the cited
                # point and reads the advisory for themselves.
                "payload": doc,
            }
        )
        print(f"embedded {doc['id']} ({len(vector)} dims)", flush=True)

    request(
        "PUT",
        f"{QDRANT}/collections/{COLLECTION}/points?wait=true",
        {"points": points},
    )
    count = request("POST", f"{QDRANT}/collections/{COLLECTION}/points/count", {"exact": True})
    print(
        f"upserted {len(points)} points; collection now holds "
        f"{count['result']['count']}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
