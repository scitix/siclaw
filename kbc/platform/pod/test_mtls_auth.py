#!/usr/bin/env python3
import ssl
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from mtls_auth import client_certificate_error, server_ssl_context


class FakeTlsTransport:
    def __init__(self, cert=None, verify_mode=ssl.CERT_OPTIONAL):
        self._ssl = SimpleNamespace(
            context=SimpleNamespace(verify_mode=verify_mode),
            getpeercert=lambda: cert,
        )

    def get_extra_info(self, name):
        return self._ssl if name == "ssl_object" else None


def request(path, transport):
    return SimpleNamespace(path=path, transport=transport)


def certificate(ou):
    return {"subject": ((('commonName', 'caller'),), (('organizationalUnitName', ou),))}


class ClientCertificateGateTest(unittest.TestCase):
    def test_empty_cert_directory_is_explicit_local_http_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(server_ssl_context(Path(tmp)))

    def test_partial_tls_material_fails_closed_instead_of_downgrading_to_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "tls.crt").touch()
            with self.assertRaisesRegex(RuntimeError, "tls.key, ca.crt"):
                server_ssl_context(Path(tmp))

    def test_health_allows_tls_without_client_certificate(self):
        self.assertIsNone(client_certificate_error(request("/health", FakeTlsTransport())))

    def test_plain_http_local_mode_remains_available(self):
        self.assertIsNone(client_certificate_error(request("/sources", None)))

    def test_tls_protected_route_requires_certificate(self):
        self.assertIn(
            "certificate required",
            client_certificate_error(request("/sources", FakeTlsTransport())).lower(),
        )

    def test_tls_context_must_verify_the_peer(self):
        error = client_certificate_error(request(
            "/sources",
            FakeTlsTransport(certificate("Runtime"), verify_mode=ssl.CERT_NONE),
        ))
        self.assertIn("verified", error.lower())

    def test_rejects_untrusted_ou(self):
        error = client_certificate_error(request(
            "/sources",
            FakeTlsTransport(certificate("AgentBox")),
        ))
        self.assertIn("runtime/gateway", error.lower())

    def test_allows_runtime_and_gateway_ous(self):
        for ou in ("Runtime", "Gateway"):
            with self.subTest(ou=ou):
                self.assertIsNone(client_certificate_error(request(
                    "/sources",
                    FakeTlsTransport(certificate(ou)),
                )))


if __name__ == "__main__":
    unittest.main()
