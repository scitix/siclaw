import { describe, it, expect } from "vitest";
import { detectLanguage } from "../detect-language.js";

describe("detectLanguage", () => {
  it("returns English for pure ASCII text", () => {
    expect(detectLanguage("Check pod status in kube-system")).toBe("English");
  });

  it("returns English for empty or whitespace input", () => {
    expect(detectLanguage("")).toBe("English");
    expect(detectLanguage("   ")).toBe("English");
  });

  it("returns English for pure CLI commands", () => {
    expect(detectLanguage("kubectl get pods --namespace kube-system -o wide")).toBe("English");
  });

  it("detects Chinese", () => {
    expect(detectLanguage("检查生产环境的 pod 状态")).toBe("Chinese");
  });

  it("detects Japanese (kana present)", () => {
    expect(detectLanguage("ポッドの状態を確認してください")).toBe("Japanese");
  });

  it("detects Korean", () => {
    expect(detectLanguage("쿠버네티스 클러스터 상태 확인")).toBe("Korean");
  });

  it("detects Russian", () => {
    expect(detectLanguage("Проверьте состояние подов")).toBe("Russian");
  });

  it("returns English for single stray CJK character in English sentence", () => {
    // Single non-Latin char should NOT trigger language switch (MIN_CHARS = 2)
    expect(detectLanguage("Check the 产 namespace")).toBe("English");
  });

  it("detects Chinese when multiple CJK chars in mixed text", () => {
    expect(detectLanguage("Check the 生产 namespace")).toBe("Chinese");
  });

  it("strips URLs before detection", () => {
    expect(detectLanguage("Go to https://example.com/日本語/page")).toBe("English");
  });

  it("strips inline code before detection", () => {
    expect(detectLanguage("Run `kubectl get 节点` command")).toBe("English");
  });

  it("strips code blocks before detection", () => {
    expect(detectLanguage("```\n这是代码块里的中文\n```\nDone")).toBe("English");
  });

  it("strips CLI flags before detection", () => {
    expect(detectLanguage("kubectl --kubeconfig=生产配置")).toBe("English");
  });

  it("strips resource paths before detection", () => {
    expect(detectLanguage("pod/nginx-abc namespace/kube-system")).toBe("English");
  });

  it("handles mixed kubectl + Chinese context", () => {
    expect(detectLanguage("kubectl get pods 显示所有 pod 的状态")).toBe("Chinese");
  });

  it("prioritizes Japanese over Chinese when kana present", () => {
    // Text with both kanji (CJK) and kana → Japanese
    expect(detectLanguage("ノードの状態を確認する")).toBe("Japanese");
  });
});
