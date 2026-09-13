#!/bin/bash
# Run only inside a disposable AgentBox container with the production capability
# allowlist and writable credentials/config/skills/user-data volumes.
set -euo pipefail
entrypoint=${1:-/usr/local/bin/agentbox-entrypoint.sh}
# First boot must create the directories hidden by the fresh emptyDir mount.
bash "$entrypoint" node -e '
  const fs=require("fs"), cp=require("child_process");
  for (const [type, group] of [["clusters","kubecred"],["hosts","hostcred"]]) {
    const d=fs.statSync("/app/.siclaw/credentials/"+type);
    const gid=Number(cp.execFileSync("getent",["group",group],{encoding:"utf8"}).split(":")[2]);
    if (d.uid!==1000 || d.gid!==gid || (d.mode&0o7777)!==0o2750) throw Error("fresh credential type is not isolated");
  }
'
runuser -u agentbox -- bash -c '
  printf "synthetic-cluster\n" > /app/.siclaw/credentials/clusters/reuse-check
  printf "synthetic-host\n" > /app/.siclaw/credentials/hosts/reuse-check
  chgrp -R agentbox /app/.siclaw/credentials
  chmod 2750 /app/.siclaw/credentials/{clusters,hosts}
'
chown agentbox:kubecred /app/.siclaw/credentials
chmod 0750 /app/.siclaw/credentials

for attempt in 1 2; do
  bash "$entrypoint" node -e '
    const fs = require("fs"), cp = require("child_process");
    if (process.getuid() !== 1000) throw Error("entrypoint did not drop uid");
    for (const [type, group, content] of [["clusters", "kubecred", "synthetic-cluster\n"], ["hosts", "hostcred", "synthetic-host\n"]]) {
      const dir = "/app/.siclaw/credentials/" + type, file = dir + "/reuse-check";
      const gid = Number(cp.execFileSync("getent", ["group", group], {encoding:"utf8"}).split(":")[2]);
      const d = fs.statSync(dir), f = fs.statSync(file);
      if (d.uid !== 1000 || d.gid !== gid || (d.mode & 0o7777) !== 0o2750) throw Error(type + " directory was not repaired");
      if (f.uid !== 1000 || f.gid !== gid || (f.mode & 0o7777) !== 0o640) throw Error(type + " file was not repaired");
      if (fs.readFileSync(file, "utf8") !== content) throw Error("credential bytes changed");
      if (cp.execFileSync("sudo", ["-n", "-u", "sandbox", "id", "-u"], {encoding:"utf8"}).trim() !== "1001") throw Error("sandbox check did not run");
      if (cp.spawnSync("sudo", ["-n", "-u", "sandbox", "cat", file]).status === 0) throw Error("sandbox read credentials");
    }
    console.log("credential directory reuse: owner, group, mode, bytes and sandbox denial verified");
  '
done
