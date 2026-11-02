# Capturing a client's HTTPS traffic (Windows, Rust/Electron/CLI)

Working recipe for capturing the *real* outbound HTTPS requests of a client
binary (CLI, desktop app, or SDK) when static inspection can't pin the wire:
header names, exact paths, and request bodies. Proven on Kiro CLI 2.37.0
(2026-11-02) — see `kiro-ide-cli-protocol.md` for what it yielded.

## When to use

- String-scan of the binary gives operation names / hosts but not the exact
  request body, path, or header set.
- Direct HTTP guesses at an endpoint keep 403/401-ing (e.g. `Bearer token
  authentication requires a resolvable operation`).
- You need byte-level proof of what the client sends, not a reconstruction.

## Recipe

1. **Tools.** `mitmproxy`/`mitmdump` (Python pip; on this box
   `C:\Users\Aria\AppData\Local\Programs\Python\Python312\Scripts\`),
   `certutil` (OS). Optional `openssl`.
2. **Generate the CA.**
   ```ps
   mitmdump --set confdir="D:\tmp\scratch\mitmproxy" --version
   ```
   creates `mitmproxy-ca-cert.cer`, `mitmproxy-ca.pem`, etc.
3. **Trust the CA in the Windows root store.**
   ```ps
   certutil -user -addstore Root "D:\tmp\scratch\mitmproxy\mitmproxy-ca-cert.cer"
   ```
   - Use `certutil -user`, **not** `Import-Certificate` (that pops a UI
     prompt and fails non-interactively).
   - Even Rust clients honor this: `rustls-native-certs` (0.8.x) reads the
     Windows root store, so the CA works without touching Mozilla roots.
4. **Start the proxy, saving flows.**
   ```ps
   mitmdump -p 18443 --set confdir="D:\tmp\scratch\mitmproxy" `
     --flow-detail 2 -w "D:\tmp\scratch\kiro-mitm-flows"
   ```
   Run it in the background (`background: true`); logs stream to the shell
   output file.
5. **Point the client at the proxy.**
   ```ps
   $env:HTTPS_PROXY="http://127.0.0.1:18443"
   $env:HTTP_PROXY ="http://127.0.0.1:18443"
   $env:NO_PROXY=""
   ```
   Hyper/reqwest/Rust AWS SDK clients honor these. Expect a few benign
   CONNECTs first (update check, telemetry, OAuth); the interesting flows are
   usually the last ones.
6. **Run the client under a strict timeout.** If it hangs, the dumper shows
   retries (same CONNECT repeating). That is a signal the proxy answered but
   failed the TLS handshake — check the CA install, not the client.
7. **Extract bodies to UTF-8 files** (the dumper's console output chokes on
   non-cp1252 characters like `\u2192` and truncates big bodies):
   ```python
   # extract_flows.py  <flows>  <outdir>
   from mitmproxy.io import FlowReader
   from mitmproxy import http
   import os, sys
   outdir = sys.argv[2]; os.makedirs(outdir, exist_ok=True)
   with open(sys.argv[1], "rb") as f:
       for i, flow in enumerate(FlowReader(f).stream()):
           if not isinstance(flow, http.HTTPFlow): continue
           req = flow.request
           target = req.headers.get("x-amz-target", "").replace("/", "_")
           name = f"{i+1:03d}-{target or 'misc'}.txt"
           with open(os.path.join(outdir, name), "w", encoding="utf-8") as w:
               w.write(f"URL: {req.method} {req.pretty_url}\n")
               w.write(f"TARGET: {target}\n")
               w.write(f"UA: {req.headers.get('user-agent','')}\n")
               w.write(f"BODY({len(req.content or b'')}B):\n")
               w.write((req.content or b"").decode("utf-8", "replace") + "\n")
   ```
   `req.raw_content` may be `None` for requests with no body — guard it.

## Pitfalls (all hit live)

- **`AWS_ENDPOINT_URL` does NOT reliably redirect Rust AWS SDK clients.** The
  Kiro CLI ignored it (still hit prod) despite the SDK supporting the env var —
  the codegen client's endpoint override or `ignore_configured_endpoint_urls`
  wins. Don't build the capture plan around it.
- **A naive echo/dump server hangs the client.** Replying to CONNECT with a
  plain `{}` leaves the TLS handshake unresolved; the client retries until
  timeout. The proxy MUST terminate TLS (that is what mitmproxy does with its
  CA).
- **`Import-Certificate` is not scriptable** (UI prompt). Use
  `certutil -user -addstore Root`.
- **Don't trust string scans for the body.** The Kiro CLI binary contains
  snake_case struct fields (`conversation_state`, `profile_arn`), but the
  actual wire is camelCase awsJson1_0 — the captured body is the truth.
- **Save flows with `-w`.** `--flow-detail` console output alone loses data on
  encoding errors; replay with `mitmdump -nr <flows> --flow-detail 4` or the
  Python extractor above.

## Cleanup

Stop the proxy process when done (`Stop-Process` on the mitmdump PID). Keep
the flow file + extracted bodies in scratch (`D:\tmp\scratch\`) as evidence;
do not commit credentials — redact `authorization` headers before adding any
sample to the repo.
