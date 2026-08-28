# asset-provenance fixture (coverage v2)

Local Siclaw fixture for attribution receipts and the Raw coverage ledger.
The control plane preserves repository files and does not duplicate these
compiler-level diagnostics.

Cases exercised: relative link, `../` cross-directory link, HTML `<img>`,
URL-encoded path (`%20`), a `?query`-suffixed target (truncated before
decoding), an angle-bracketed destination with a trailing `#fragment`
(`<assets/c d.png>#fig1` — unwrapped even though the destination does not
*end* in `>`), a body reference to a nonexistent asset (no edge, no error), a
0-byte download-failed placeholder, `assets/sheets/*.md` (a content file, not
media), one image shared by a cited and an unaccounted document (auto via the
accounted one), a standalone repository image (retained via the source tree), an image
inheriting its document's exclusion, and a directly-cited asset (still counts
as cited, v1 compatibility). Case-insensitivity of the `assets`/`*.assets`
segment is locked by a unit test (an uppercase dir is not portable on a
case-insensitive filesystem), not by a fixture file.

Image files hold placeholder bytes — coverage never decodes them; only their
path and presence in the inventory matter.
