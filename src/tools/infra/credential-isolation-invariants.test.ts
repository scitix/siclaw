import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * The credential isolation is expressed in a Dockerfile and a shell script, so no unit test can execute
 * it — but its two load-bearing properties are textual, and both were violated for four months without
 * anything failing. These tests pin the text.
 *
 * How it broke: ADR-010 (2026-03) created `sandbox` with no supplementary groups, and the entrypoint
 * chowned the credential tree to `kubecred` so setgid `kubectl` could traverse it. Correct then — the
 * group meant "kubectl and the owner". The host-credential pipeline (2026-04) granted `sandbox` both
 * credential groups, for a setgid `ssh` reader the comment called "future" and which was never built.
 * From that moment the same chown meant "every child process", and the setgid bit on kubectl granted
 * nothing sandbox lacked. The Dockerfile's own directory modes still looked right, so reading it could
 * not reveal the problem; only measuring a container after the entrypoint ran could.
 *
 * The fix is therefore the MEMBERSHIP, not the directory mode. Tightening the parent to
 * `agentbox:agentbox` instead — the intuitive move, and one I tried — locks the setgid reader out too,
 * and every kubectl the agent issues fails with `permission denied`. That is measured, not theorised.
 *
 * The assertions span both files because the invariant lives in their interaction: safe traversal is
 * "kubecred parent" AND "sandbox in no credential group", and neither file states both.
 */
const repoRoot = resolve(import.meta.dirname, "../../..");
const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile.agentbox"), "utf8");
const entrypoint = readFileSync(resolve(repoRoot, "docker/agentbox-entrypoint.sh"), "utf8");

describe("credential isolation: the sandbox user holds no credential group", () => {
  it("creates sandbox with no supplementary groups", () => {
    const line = dockerfile.split("\n").find((l) => l.includes("useradd") && l.includes("1001"));
    expect(line, "the sandbox useradd line").toBeDefined();
    // A group here hands every reader binary in the image the same access the setgid kubectl has, which
    // makes that setgid bit decorative and the argv whitelist the only thing left.
    expect(line).not.toMatch(/-G/);
    expect(line).not.toMatch(/kubecred|hostcred/);
  });

  it("still grants agentbox the groups it owns the files with", () => {
    const line = dockerfile.split("\n").find((l) => l.includes("useradd") && l.includes("1000"));
    expect(line).toContain("kubecred");
    expect(line).toContain("hostcred");
  });

  it("keeps kubectl setgid — it is the one sandbox-side reader", () => {
    expect(dockerfile).toMatch(/chgrp kubecred \/usr\/local\/bin\/kubectl/);
    expect(dockerfile).toMatch(/chmod 2755 \/usr\/local\/bin\/kubectl/);
  });

  it("refuses to start if the image was built with sandbox in a credential group", () => {
    // Belt to the Dockerfile's braces: a wrong image fails loudly at startup instead of running with the
    // isolation silently absent.
    expect(entrypoint).toMatch(/for grp in kubecred hostcred/);
    expect(entrypoint).toMatch(/id -nG sandbox/);
    expect(entrypoint).toMatch(/FATAL: sandbox is a member/);
  });
});

describe("credential isolation: the entrypoint does not re-open what the image closes", () => {
  it("keeps the parent traversable by kubecred — the group setgid kubectl runs with", () => {
    // Not a weakening: `kubecred` traversal means "kubectl and the owner" precisely because `sandbox`
    // belongs to no credential group. Locking the parent to `agentbox:agentbox` instead locks the setgid
    // reader out too — measured in a live pod, where every kubectl the agent issues then fails with
    // `permission denied`. The group grant on sandbox was the defect, not this line.
    expect(entrypoint).toMatch(/chown agentbox:kubecred \/app\/\.siclaw\/credentials\b/);
    expect(entrypoint).toMatch(/chmod 0750 \/app\/\.siclaw\/credentials\b/);
  });

  it("never chowns the whole tree to one credential group", () => {
    // The exact line that caused this: `chown -R agentbox:kubecred /app/.siclaw/credentials` (no
    // subdirectory). It re-grouped the parent AND flattened hosts/ into kubecred.
    const flattening = /chown\s+-R\s+agentbox:(kubecred|hostcred)\s+\/app\/\.siclaw\/credentials\s*(?![/\w])/;
    expect(entrypoint).not.toMatch(flattening);
  });

  it("keeps each credential type in its own group, setgid", () => {
    expect(entrypoint).toMatch(/chown -R agentbox:kubecred \/app\/\.siclaw\/credentials\/clusters/);
    expect(entrypoint).toMatch(/chmod 2750 \/app\/\.siclaw\/credentials\/clusters/);
    expect(entrypoint).toMatch(/chown -R agentbox:hostcred \/app\/\.siclaw\/credentials\/hosts/);
    expect(entrypoint).toMatch(/chmod 2750 \/app\/\.siclaw\/credentials\/hosts/);
  });

  it("refuses to start when the permission fix did not take effect", () => {
    // Every chown ends in `|| true` — correct, so a standalone Docker run without CAP_CHOWN is not
    // bricked — but it means the isolation can fail to apply in silence. The volume is an emptyDir,
    // mounted root-owned, so a chown that does not land leaves the tree readable by every child. The
    // group guard does not cover this: it checks sandbox's group membership, an image property, not the
    // directory's owner.
    //
    // The realistic path here is a spec change, not a bug — `runAsNonRoot: true`, a restricted Pod
    // Security Standard, or CHOWN dropped from the capability list — and the pod would look healthy.
    // Verified against the spawner: the pod has no runAsUser and explicitly adds CHOWN/FOWNER, so root
    // + the capability is the contract this depends on.
    expect(entrypoint).toMatch(/stat -c '%U:%G' \/app\/\.siclaw\/credentials/);
    expect(entrypoint).toMatch(/agentbox:kubecred.*expected|expected agentbox:kubecred/);
    expect(entrypoint).toMatch(/FATAL: \/app\/\.siclaw\/credentials is/);
    // and it must EXIT, not warn — a warning in a container log is not a control
    const block = entrypoint.slice(entrypoint.indexOf("cred_owner="));
    expect(block.slice(0, block.indexOf("\nfi")), "the check must exit non-zero").toContain("exit 1");
  });

  it("depends on a pod that starts as root with CAP_CHOWN, and says so", () => {
    // The entrypoint cannot fix permissions without it, and the spawner is where that is decided. If
    // this ever changes, the guard above turns a silent loss of isolation into a refusal to start —
    // which is the point, but the pairing should be visible from here.
    const spawner = readFileSync(resolve(repoRoot, "src/gateway/agentbox/k8s-spawner.ts"), "utf8");
    expect(spawner).not.toMatch(/runAsNonRoot:\s*true/);
    expect(spawner).toMatch(/"CHOWN"/);
    expect(spawner).toMatch(/"FOWNER"/);
  });

  it("keeps credential files group-readable for the setgid reader", () => {
    // 0640 is what lets setgid kubectl read a kubeconfig. It is only safe because no low-privilege user
    // is in that group — which is the assertion in the block above.
    expect(entrypoint).toMatch(/-type f -exec chmod 0640/);
  });

  it("agrees with the Dockerfile about the per-type layout", () => {
    // If the image stops creating these directories, the entrypoint's chowns silently no-op (`|| true`)
    // and the parent's 0750 is all that is left.
    expect(dockerfile).toMatch(/credentials\/clusters/);
    expect(dockerfile).toMatch(/credentials\/hosts/);
  });
});

describe("credential isolation: only one code path drops to sandbox", () => {
  // This used to assert that the drop lived in restricted-bash.ts and in none of six named files. The
  // wrapping has since moved to infra/sandbox-exec.ts so a second read-only tool could reuse it
  // instead of importing a tool module, which makes the "one path" claim checkable directly rather
  // than by enumerating the files it must not be in.
  //
  // Why a SECOND caller does not weaken the audit this invariant came from: the concern was a
  // sandbox-side process needing to read a credential file itself, since that is what dropping the
  // group memberships would break. Every caller here reaches credentials only through setgid
  // `kubectl`, exactly as restricted_bash does — so the number of callers is not the property that
  // matters. The number of IMPLEMENTATIONS is, and it is one.
  it("has exactly one implementation of the drop, in infra/sandbox-exec.ts", () => {
    const files = execSync("git ls-files 'src/**/*.ts'", { cwd: repoRoot, encoding: "utf8" })
      .split("\n").map((f) => f.trim()).filter((f) => f && !f.endsWith(".test.ts"));

    // Both spellings. The argv form was a blind spot in the previous version of this test: its regex
    // only matched the shell string, so `spawn("sudo", ["-n", "-E", "-u", "sandbox", …])` — which is
    // how the session reap becomes sandbox — would have passed in any file at all.
    const asString = /sudo\s+(?:-\S+\s+)*-u\s+sandbox/;
    const asArgv = /"sudo"\s*,\s*\[[^\]]*"sandbox"/s;

    const offenders = files.filter((f) => {
      const body = readFileSync(resolve(repoRoot, f), "utf8");
      // Strip comments so the prose references in tool-registry.ts and background-bash-runner.ts,
      // which describe the wrapping without performing it, are not counted.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      return asString.test(code) || asArgv.test(code);
    });

    expect(offenders).toEqual(["src/tools/infra/sandbox-exec.ts"]);
  });

  it("keeps the drop out of the tools that must run as agentbox", () => {
    // Retained from the original: these read credentials or manage cluster resources in the node
    // process, and a sandbox child in any of them would need the group membership back.
    for (const f of [
      "src/tools/cmd-exec/node-exec.ts",
      "src/tools/cmd-exec/pod-exec.ts",
      "src/tools/cmd-exec/host-exec.ts",
      "src/tools/script-exec/local-script.ts",
      "src/tools/infra/debug-pod.ts",
      "src/tools/infra/k8s-checks.ts",
    ]) {
      expect(readFileSync(resolve(repoRoot, f), "utf8"), f).not.toMatch(/sudo\s+(-\S+\s+)*-u\s+sandbox/);
    }
  });

  it("keeps ssh out of the command registry, so no sandbox child can dial one", () => {
    // Host credentials therefore need no sandbox-side reader at all — the basis for dropping hostcred.
    const sets = readFileSync(resolve(repoRoot, "src/tools/infra/command-sets.ts"), "utf8");
    for (const bin of ["ssh", "scp", "sftp", "sshpass"]) {
      expect(sets, bin).not.toMatch(new RegExp(`^\\s+${bin}:\\s*\\{`, "m"));
    }
  });
});
