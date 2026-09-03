import { describe, expect, it } from "vitest";
import { EFFECT_RANK, effectExceedsCeiling, type ToolEffect } from "./tool-effects.js";

describe("effect ranks", () => {
  it("orders the comparable effects from read to destructive", () => {
    expect(EFFECT_RANK.observe).toBeLessThan(EFFECT_RANK.local_write);
    expect(EFFECT_RANK.local_write).toBeLessThan(EFFECT_RANK.external_write);
    expect(EFFECT_RANK.external_write).toBeLessThan(EFFECT_RANK.destructive);
  });

  it("keeps credential_read off the scale (it is not 'more writing')", () => {
    expect("credential_read" in EFFECT_RANK).toBe(false);
  });
});

describe("effectExceedsCeiling", () => {
  it("permits an effect at or below the ceiling", () => {
    expect(effectExceedsCeiling("observe", "observe")).toBe(false);
    expect(effectExceedsCeiling("observe", "destructive")).toBe(false);
    expect(effectExceedsCeiling("local_write", "local_write")).toBe(false);
    expect(effectExceedsCeiling("external_write", "external_write")).toBe(false);
    expect(effectExceedsCeiling("external_write", "destructive")).toBe(false);
    expect(effectExceedsCeiling("destructive", "destructive")).toBe(false);
  });

  it("refuses an effect above the ceiling", () => {
    expect(effectExceedsCeiling("local_write", "observe")).toBe(true);
    expect(effectExceedsCeiling("external_write", "observe")).toBe(true);
    expect(effectExceedsCeiling("external_write", "local_write")).toBe(true);
    expect(effectExceedsCeiling("destructive", "external_write")).toBe(true);
  });

  it("treats credential_read as exceeding EVERY ceiling", () => {
    for (const ceiling of ["observe", "local_write", "external_write", "destructive", "anything"]) {
      expect(effectExceedsCeiling("credential_read", ceiling)).toBe(true);
    }
  });

  it("treats an unknown ceiling as observe, so an unrecognised value cannot widen anything", () => {
    // A control plane shipping a ceiling this runtime predates must not thereby
    // grant more than the most restrictive one.
    for (const unknown of ["", "OBSERVE", "read_only", "admin", "*"]) {
      expect(effectExceedsCeiling("observe", unknown)).toBe(false);
      expect(effectExceedsCeiling("local_write", unknown)).toBe(true);
      expect(effectExceedsCeiling("destructive", unknown)).toBe(true);
    }
  });

  it("covers every declared effect against every declared ceiling", () => {
    const effects: ToolEffect[] = ["observe", "local_write", "external_write", "destructive", "credential_read"];
    for (const effect of effects) {
      for (const ceiling of Object.keys(EFFECT_RANK)) {
        expect(typeof effectExceedsCeiling(effect, ceiling)).toBe("boolean");
      }
    }
  });
});
