# asset-provenance fixture (coverage v2)

Shared, byte-for-byte contract between siclaw `selfcheck.py` and the sicore
adoption ledger (DESIGN-kb-asset-provenance-2026-07-22 §六). Both repos run
their edge extraction + coverage math over this same `raw/` + `candidate/` +
`authoring/EXCLUSIONS.json` and assert the result equals `expected.json`.

Cases exercised: relative link, `../` cross-directory link, HTML `<img>`,
URL-encoded path (`%20`), a body reference to a nonexistent asset (no edge,
no error), a 0-byte download-failed placeholder, `assets/sheets/*.md` (a
content file, not media), one image shared by a cited and an unaccounted
document (auto via the accounted one), an orphan image (unaccounted unless
excluded), an image inheriting its document's exclusion, and a directly-cited
asset (still counts as cited, v1 compatibility).

Image files hold placeholder bytes — coverage never decodes them; only their
path and presence in the inventory matter.
