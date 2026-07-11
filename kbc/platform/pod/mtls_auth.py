"""Application-layer authorization for compile-box's optional-client-cert TLS.

The TLS handshake requests and verifies a certificate when one is presented,
while allowing Kubernetes to reach ``/health`` without one. Protected routes
therefore complete the policy here using the verified TLS transport state.
"""

from __future__ import annotations

import ssl
from pathlib import Path


TRUSTED_CLIENT_OUS = frozenset({"Runtime", "Gateway"})


def server_ssl_context(cert_dir: Path):
    """Build the production TLS context without allowing partial-cert downgrade.

    A completely empty directory means intentional local HTTP mode. If any TLS
    material is present, all three files are mandatory; otherwise falling back
    to HTTP would silently remove the application-layer certificate gate.
    """
    crt, key, ca = cert_dir / "tls.crt", cert_dir / "tls.key", cert_dir / "ca.crt"
    present = {path.name: path.exists() for path in (crt, key, ca)}
    if not any(present.values()):
        return None
    missing = [name for name, exists in present.items() if not exists]
    if missing:
        raise RuntimeError(f"Incomplete compile-box TLS material; missing: {', '.join(missing)}")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    ctx.load_verify_locations(str(ca))
    # Kubelet/local exec probes reach /health without a client certificate.
    # Any certificate that IS presented is verified against the CA here; the
    # application middleware requires it and authorizes its OU on other routes.
    ctx.verify_mode = ssl.CERT_OPTIONAL
    return ctx


def client_certificate_error(request) -> str | None:
    """Return an authorization error, or ``None`` when the request is allowed.

    A request with no TLS transport is the supported local-development HTTP
    mode. HTTPS callers must present a CA-verified certificate whose OU is one
    of the trusted runtime roles. ``/health`` is the only TLS exception.
    """
    if request.path == "/health":
        return None

    transport = request.transport
    if transport is None:
        return None
    ssl_object = transport.get_extra_info("ssl_object")
    if ssl_object is None:
        return None

    verify_mode = getattr(getattr(ssl_object, "context", None), "verify_mode", ssl.CERT_NONE)
    if verify_mode not in (ssl.CERT_OPTIONAL, ssl.CERT_REQUIRED):
        return "Client certificate was not verified by the TLS transport"

    try:
        peer_cert = ssl_object.getpeercert()
    except (OSError, ValueError, ssl.SSLError):
        peer_cert = None
    if not peer_cert:
        return "Client certificate required"

    ous = {
        str(value)
        for rdn in peer_cert.get("subject", ())
        for key, value in rdn
        if key == "organizationalUnitName"
    }
    if not ous.intersection(TRUSTED_CLIENT_OUS):
        return "Forbidden: only Runtime/Gateway client certificates may access this API"
    return None
