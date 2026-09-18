#!/usr/bin/env python3
"""A plain-HTTP front door for an HTTPS service with an untrusted certificate.

WHY THIS EXISTS, and why it is not a workaround for the security model.

SUSE Security's controller serves its REST API over TLS with a self-signed
certificate that carries no service SANs. OpenShell's L7 proxy verifies every
upstream certificate against webpki-roots plus whatever CA bundle it finds in
the sandbox image (`crates/openshell-sandbox/src/l7/tls.rs`,
`build_upstream_client_config`), and there is no escape hatch: no `insecure`
flag on a policy endpoint, and no way to add a CA, because sandbox volumes
support only `persistent_volume_claim` and the CA has to be inside the image.
So from a sandbox, NeuVector is a `NET:OPEN ALLOWED` immediately followed by a
`NET:FAIL` and `curl: (35) Connection reset by peer` — a TLS failure that reads
exactly like a policy denial.

The three ways out, and why this is the one:

  - Bake the CA into the sandbox image. Works, and makes a published image
    specific to one cluster's PKI.
  - `tls: skip` with `allow_uninspected_credentials: true`. This is the one to
    refuse. It stops the proxy inspecting the stream, which means the proxy can
    no longer inject the API key, which means the real key has to be handed to
    the sandbox — destroying the property the whole profile exists to show.
  - This shim.

WHAT IT DOES AND DOES NOT PRESERVE. It accepts plain HTTP on the cluster
network and relays the bytes over TLS to the controller, not verifying the
certificate. The two sandbox policies then name the shim over HTTP, so the L7
proxy still parses every request, still enforces the method/path allow list —
including the `POST /v1/policy/rule` denial that is the demo — and still
injects the API key at the egress boundary. The sandbox still never holds a
credential. What is given up is precisely one thing: the hop from this pod to
the controller is encrypted but unauthenticated, so a man in the middle inside
the cluster network could impersonate the controller to this shim. That is a
real weakening and it is stated in the README rather than buried here.

TWO MODES, AND WHICH ONE YOU GET DEPENDS ON `REWRITE_HOST`.

  - Unset (SUSE Security): a byte relay. It parses nothing, so there is nothing
    in it to get wrong about a request: the client's HTTP/1.1 bytes go up the
    TLS socket as they arrive and the response comes back the same way.
    Keep-alive, chunked encoding and HTTP/1.0 all work because none of them are
    understood. This was the only mode until 2026-09-17.

  - Set (Rancher): an HTTP/1.1 reverse proxy that replaces the inbound `Host`
    header with `REWRITE_HOST` before forwarding. Rancher is behind an ingress
    that routes strictly on that header, and the shim's Service name is not the
    vhost, so a relayed request arrives with the wrong `Host` and nginx answers
    404 — measured, and it is what broke the first end-to-end deploy.

    The obvious fix, setting `-H "Host: …"` in the client, does not work and
    the reason is worth recording: OpenShell's forward proxy reconstructs the
    upstream request from the absolute-form request URI
    (`crates/openshell-sandbox/src/l7/proxy.rs`) and DISCARDS a client-supplied
    `Host` override. So the header has to be corrected on this side of the
    proxy, which means something here has to parse HTTP. Rewriting the byte
    stream instead was rejected: a body can contain the same bytes, and with
    keep-alive there is no reliable way to know which occurrence begins a
    request line.

    Rejected alternatives outside this file: a CoreDNS override for the vhost
    (it would also redirect `cattle-cluster-agent`), and naming the Service
    after the vhost (Service names cannot contain dots).

Stdlib only, running on the orchestrator image, for the same reason as
orchestrator.py: this profile installs nothing at runtime.
"""

from __future__ import annotations

import asyncio
import http.client
import os
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_HOST = os.environ.get("UPSTREAM_HOST", "")
UPSTREAM_PORT = int(os.environ.get("UPSTREAM_PORT", "10443"))
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "10443"))
REWRITE_HOST = os.environ.get("REWRITE_HOST", "")

if not UPSTREAM_HOST:
    sys.exit("tls-shim: UPSTREAM_HOST is not set")

# Deliberate, and the only line in this file that weakens anything. See the
# module docstring: the certificate is the thing that cannot be verified, which
# is the entire reason the shim exists.
TLS = ssl.create_default_context()
TLS.check_hostname = False
TLS.verify_mode = ssl.CERT_NONE


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, ssl.SSLError):
        pass
    finally:
        # Half-close, so the peer sees EOF rather than waiting out a timeout on
        # a response that has already finished.
        try:
            writer.write_eof()
        except (OSError, RuntimeError):
            pass


async def handle(down_r: asyncio.StreamReader, down_w: asyncio.StreamWriter) -> None:
    try:
        up_r, up_w = await asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT, ssl=TLS)
    except OSError as exc:
        # Nothing useful to say in HTTP terms — this is a byte relay — so drop
        # the connection and leave the diagnosis in the log.
        print(f"upstream connect failed: {exc}", flush=True)
        down_w.close()
        return
    try:
        await asyncio.gather(_pump(down_r, up_w), _pump(up_r, down_w))
    finally:
        for writer in (up_w, down_w):
            writer.close()


async def main() -> None:
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN_PORT)
    print(
        f"tls-shim: :{LISTEN_PORT} (plain) -> {UPSTREAM_HOST}:{UPSTREAM_PORT} "
        "(TLS, certificate NOT verified)",
        flush=True,
    )
    async with server:
        await server.serve_forever()


# ------------------------------------------------- mode 2: rewrite `Host:`


# Hop-by-hop, plus `host` itself. RFC 7230 §6.1 says these belong to a single
# connection and must not be forwarded; `host` is dropped because supplying it
# is the entire job of this mode.
_DROP = frozenset(
    (
        "host",
        "connection",
        "proxy-connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    )
)


class _Rewriter(BaseHTTPRequestHandler):
    # HTTP/1.1 so that curl's default keep-alive is honoured rather than
    # answered with a connection close per request.
    protocol_version = "HTTP/1.1"

    def _forward(self) -> None:
        # An absolute-form request line would be unusual here — the proxy
        # normally sends origin-form — but a `GET http://host/p` that reached
        # this handler must not be forwarded with the authority still attached.
        path = self.path
        if path.startswith("http://") or path.startswith("https://"):
            path = "/" + path.split("://", 1)[1].split("/", 1)[-1]

        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None

        headers = {
            k: v for k, v in self.headers.items() if k.lower() not in _DROP
        }
        headers["Host"] = REWRITE_HOST

        conn = http.client.HTTPSConnection(
            UPSTREAM_HOST, UPSTREAM_PORT, context=TLS, timeout=300
        )
        try:
            # `Host:` is in `headers`, and http.client leaves an explicitly
            # supplied one alone. The connection still goes to UPSTREAM_HOST.
            conn.request(self.command, path, body=body, headers=headers)
            upstream = conn.getresponse()
            # Buffered rather than streamed, and answered with an explicit
            # content-length. The bodies here are Kubernetes objects — tens of
            # kilobytes — and buffering removes any chance of this handler
            # disagreeing with the client about where a response ends.
            payload = upstream.read()
        except OSError as exc:
            print(f"upstream request failed: {exc}", flush=True)
            self.send_error(502, "upstream request failed")
            return
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - nothing to do but continue
                pass

        self.send_response(upstream.status, upstream.reason)
        for key, value in upstream.getheaders():
            if key.lower() in _DROP or key.lower() == "content-length":
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    # The five verbs the Rancher helper can issue. No HEAD: nothing sends one,
    # and a buffered handler would have to special-case its empty body.
    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _forward

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - base API
        """Quiet. A denied or failed request is visible in the proxy's audit log."""


def serve_rewriting() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), _Rewriter)
    print(
        f"tls-shim: :{LISTEN_PORT} (plain) -> {UPSTREAM_HOST}:{UPSTREAM_PORT} "
        f"(TLS, certificate NOT verified), rewriting Host: {REWRITE_HOST}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    try:
        if REWRITE_HOST:
            serve_rewriting()
        else:
            asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
