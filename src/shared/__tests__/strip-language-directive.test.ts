import { describe, it, expect } from "vitest";
import { stripLanguageDirective } from "../strip-language-directive.js";

describe("stripLanguageDirective", () => {
  it("strips a leading injected directive", () => {
    expect(stripLanguageDirective("[System: respond in Chinese]\n你好")).toBe("你好");
    expect(stripLanguageDirective("[System: respond in Japanese]\nこんにちは")).toBe("こんにちは");
  });

  it("keeps a leading Deep-Investigation marker but strips the directive after it", () => {
    expect(stripLanguageDirective("[Deep Investigation]\n[System: respond in Chinese]\n你好")).toBe(
      "[Deep Investigation]\n你好",
    );
    expect(stripLanguageDirective("[DP_EXIT]\n[System: respond in Chinese]\n继续")).toBe("[DP_EXIT]\n继续");
  });

  it("leaves clean / English / directive-free messages untouched", () => {
    expect(stripLanguageDirective("你好")).toBe("你好");
    expect(stripLanguageDirective("hello there")).toBe("hello there");
    expect(stripLanguageDirective("")).toBe("");
  });

  it("only strips at the start, not a mid-message occurrence the user typed", () => {
    const typed = "what does [System: respond in Chinese] mean?";
    expect(stripLanguageDirective(typed)).toBe(typed);
  });

  it("strips only the directive line, preserving the rest of a multi-line message", () => {
    expect(stripLanguageDirective("[System: respond in Chinese]\n第一行\n第二行")).toBe("第一行\n第二行");
  });
});
