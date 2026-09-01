/**
 * Reading the validity window off an mTLS leaf certificate.
 *
 * Lives in `shared/` because BOTH sides of the mTLS pair need it and neither may import
 * the other: the Runtime decides when to re-issue an AgentBox certificate, while the
 * AgentBox checks the one it was handed and says so if it is already dead. Parsing is
 * `node:crypto`'s X509 rather than node-forge — the AgentBox image has no reason to pull
 * a PKI library in just to read one date.
 */

import { X509Certificate } from "node:crypto";

/**
 * How long an AgentBox leaf certificate is valid for.
 *
 * THE definition, not a copy: `issueAgentBoxCertificate` imports this for its
 * `validityDays`. It lives here rather than in the cert manager so the AgentBox side can
 * reason about its own certificate's lifetime without importing Runtime-only code — and so
 * that the lifetime and the renewal window below, which only make sense relative to each
 * other, are stated in one place.
 */
export const AGENTBOX_CERT_VALIDITY_DAYS = 30;

/**
 * How much life must be left before a certificate is considered still good.
 *
 * A third of the lifetime, and it must stay at or under {@link MAX_RENEW_BEFORE_DAYS} (a
 * half) for the reason given there — the two fractions bound the same value from the same
 * side, this one by what renewal NEEDS and that one by what the pool can SURVIVE.
 *
 * The window has to cover the whole path back to a working certificate, which is longer
 * than it looks: the Secret is only re-issued when a pod is created, so a box must first be
 * drained, then replaced, and a resident pool box is replaced one at a time under a drain
 * budget. Ten days of slack means an operator who notices nothing still ends up with a
 * valid certificate.
 */
export const AGENTBOX_CERT_RENEW_BEFORE_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Largest renewal window that will be honoured: HALF the certificate lifetime.
 *
 * 🔴 MEASURED, NOT GUESSED. A window at or above the lifetime makes every certificate due
 * the instant it is signed, so a box is drained for "nearing expiry", its replacement is
 * signed, and the replacement is judged the same way — the pool churns until the drain
 * budget trips. Observed on a live cluster with the window set to 40 days against a 30-day
 * lifetime: eight boxes drained in a few minutes, ending in
 * "that is a loop, not a deploy".
 *
 * Half also bounds the STEADY-STATE cost, which a bare `< lifetime` would not: a 29-day
 * window on a 30-day certificate leaves one day of calm and then rolls the whole pool
 * every day thereafter. At half, a pool rolls at most once per half-lifetime.
 */
export const MAX_RENEW_BEFORE_DAYS = AGENTBOX_CERT_VALIDITY_DAYS / 2;

/**
 * The renewal window in force, honouring `SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS`.
 *
 * The override is for OPERATIONAL adjustment of the lead time — bringing replacement
 * forward on a cluster where a drain plus a cold start takes longer than the default
 * allows. It is read per call, so a value can be changed with a restart rather than an
 * image build.
 *
 * It is NOT a way to force renewal on demand. That was its first purpose, and a live test
 * showed why it cannot be: any window big enough to make a FRESH certificate due is by
 * definition big enough to make its replacement due as well. See MAX_RENEW_BEFORE_DAYS.
 *
 * Rejected values fall back to the default rather than failing: a typo here must not be
 * able to stop certificates being renewed at all, which is the failure this whole mechanism
 * exists to prevent.
 */
export function renewBeforeMsInForce(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS;
  if (raw === undefined || raw === "") return AGENTBOX_CERT_RENEW_BEFORE_MS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0 || days > MAX_RENEW_BEFORE_DAYS) {
    console.warn(
      `[cert-validity] ignoring SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS=${raw} — want a number of days in ` +
      `0 < d <= ${MAX_RENEW_BEFORE_DAYS} (half the ${AGENTBOX_CERT_VALIDITY_DAYS}-day certificate lifetime; ` +
      `a larger window makes every fresh certificate due on sight and churns the pool). ` +
      `Using the default ${AGENTBOX_CERT_RENEW_BEFORE_MS / (24 * 60 * 60 * 1000)}d`,
    );
    return AGENTBOX_CERT_RENEW_BEFORE_MS;
  }
  return days * 24 * 60 * 60 * 1000;
}

/**
 * The `notAfter` of a PEM certificate, or null if it cannot be read.
 *
 * Null means "no answer", NEVER "expired": callers decide what to do with an unreadable
 * certificate, and treating a parse failure as expiry would recycle every pod of an agent
 * the moment this function met a PEM it did not like.
 */
export function readCertificateNotAfter(pem: string): Date | null {
  try {
    const cert = new X509Certificate(pem);
    const notAfter = cert.validToDate;
    // An unparseable date surfaces as an Invalid Date rather than a throw.
    return Number.isFinite(notAfter.getTime()) ? notAfter : null;
  } catch {
    return null;
  }
}

/**
 * Whether a certificate is close enough to expiry that it should be replaced.
 *
 * An unknown `notAfter` (null) is NOT due for renewal — see readCertificateNotAfter. An
 * already-expired certificate is, which is the case this exists for.
 */
export function certificateNeedsRenewal(
  notAfter: Date | null,
  now = new Date(),
  renewBeforeMs = renewBeforeMsInForce(),
): boolean {
  if (!notAfter) return false;
  return notAfter.getTime() - now.getTime() < renewBeforeMs;
}

/** Whether a certificate is already outside its validity window. Unknown ⇒ false. */
export function certificateHasExpired(notAfter: Date | null, now = new Date()): boolean {
  if (!notAfter) return false;
  return notAfter.getTime() <= now.getTime();
}

/**
 * `notAfter` as the value of a K8s label: whole seconds since the epoch.
 *
 * A label value may only hold alphanumerics plus `-_.`, so the RFC3339 form a human would
 * prefer is not available. Seconds are enough — the renewal window is measured in days.
 */
export function certExpiryLabel(notAfter: Date): string {
  return String(Math.floor(notAfter.getTime() / 1000));
}

/** Inverse of {@link certExpiryLabel}. Unparseable or non-positive ⇒ null (i.e. unknown). */
export function parseCertExpiryLabel(value: string | undefined): Date | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}
