import { describe, it, expect } from "vitest";
import { detectScriptLanguage } from "../detect-language.js";

describe("detectScriptLanguage", () => {
  it("returns English for pure ASCII text", () => {
    expect(detectScriptLanguage("Check pod status in kube-system")).toBe("English");
  });

  it("has no opinion about empty or whitespace input", () => {
    expect(detectScriptLanguage("")).toBeNull();
    expect(detectScriptLanguage("   ")).toBeNull();
  });

  it("returns English for pure CLI commands", () => {
    expect(detectScriptLanguage("kubectl get pods --namespace kube-system -o wide")).toBe("English");
  });

  it("detects Chinese", () => {
    expect(detectScriptLanguage("检查生产环境的 pod 状态")).toBe("Chinese");
  });

  it("detects Japanese (kana present)", () => {
    expect(detectScriptLanguage("ポッドの状態を確認してください")).toBe("Japanese");
  });

  it("detects Korean", () => {
    expect(detectScriptLanguage("쿠버네티스 클러스터 상태 확인")).toBe("Korean");
  });

  it("detects Russian", () => {
    expect(detectScriptLanguage("Проверьте состояние подов")).toBe("Russian");
  });

  it("returns English for single stray CJK character in English sentence", () => {
    // Single non-Latin char should NOT trigger language switch (MIN_CHARS = 2)
    expect(detectScriptLanguage("Check the 产 namespace")).toBe("English");
  });

  it("detects Chinese when multiple CJK chars in mixed text", () => {
    expect(detectScriptLanguage("Check the 生产 namespace")).toBe("Chinese");
  });

  it("strips URLs before detection", () => {
    expect(detectScriptLanguage("Go to https://example.com/日本語/page")).toBe("English");
  });

  it("strips inline code before detection", () => {
    expect(detectScriptLanguage("Run `kubectl get 节点` command")).toBe("English");
  });

  it("strips code blocks before detection", () => {
    expect(detectScriptLanguage("```\n这是代码块里的中文\n```\nDone")).toBe("English");
  });

  it("strips CLI flags before detection", () => {
    expect(detectScriptLanguage("kubectl --kubeconfig=生产配置")).toBe("English");
  });

  // Stripping is aggressive by design, and a message that is ONLY a resource
  // path has nothing left afterwards. Under the old single-answer contract that
  // came back as "English"; it is really "no evidence", which is what lets a
  // Chinese-configured agent keep answering in Chinese.
  it("has no opinion left once a bare resource path is stripped", () => {
    expect(detectScriptLanguage("pod/nginx-abc namespace/kube-system")).toBeNull();
  });

  it("handles mixed kubectl + Chinese context", () => {
    expect(detectScriptLanguage("kubectl get pods 显示所有 pod 的状态")).toBe("Chinese");
  });

  it("prioritizes Japanese over Chinese when kana present", () => {
    // Text with both kanji (CJK) and kana → Japanese
    expect(detectScriptLanguage("ノードの状態を確認する")).toBe("Japanese");
  });
});

describe("detectScriptLanguage — telling \"English\" apart from \"cannot tell\"", () => {
  // The reported bug: a Chinese conversation flipped to English the moment the
  // user steered a bare "1". Digits are not evidence of a language, but the old
  // single-answer contract counted them as English.
  it.each(["1", "2", "3", "  ", "42", "!!!", "?", "1.5"])("has no opinion about %j", (text) => {
    expect(detectScriptLanguage(text)).toBeNull();
  });

  // Latin script still resolves. It is weak evidence — Latin is shared by dozens
  // of languages — but it is the only evidence there is, and calling it absent
  // would answer an English question in the agent's configured language, which
  // inverts "what the user wrote wins".
  it.each(["ok", "what is wrong with the cluster", "kubectl get pods"])(
    "reads %j as English", (text) => {
      expect(detectScriptLanguage(text)).toBe("English");
    },
  );

  it("still reads a real script", () => {
    expect(detectScriptLanguage("集群怎么了")).toBe("Chinese");
    expect(detectScriptLanguage("クラスタの状態")).toBe("Japanese");
  });

  // A single CJK character in Latin text is below the bar for claiming Chinese;
  // the surrounding Latin is what decides.
  it("falls back to the Latin test when a script is below threshold", () => {
    expect(detectScriptLanguage("restart the 集 pod")).toBe("English");
    expect(detectScriptLanguage("集 1")).toBeNull();
  });
});
