# Command Whitelist Reference

This document describes all commands allowed by Siclaw's execution tools and the security restrictions applied to each. All filtering uses **whitelist mechanisms** — unknown commands, flags, subcommands, and actions are blocked by default.

> **Source of truth**: `src/tools/command-sets.ts`

## Architecture

Commands are validated in two layers:

1. **Command whitelist** (`ALLOWED_COMMANDS`) — only listed binaries are allowed to execute. Any unlisted binary is blocked immediately.
2. **Per-command validators** — whitelisted commands with dangerous capabilities have additional flag/subcommand validation. Only explicitly allowed flags and actions are permitted.

These validations apply to three tools:
- `restricted-bash` — sandboxed shell execution (also allows `kubectl` and skill scripts)
- `node-exec` — command execution on Kubernetes nodes via privileged debug pods
- `kubectl-exec` — command execution inside Kubernetes pods

Additionally, `restricted-bash` validates **shell operators** (see [Shell Operator Restrictions](#shell-operator-restrictions)).

---

## Excluded Commands

The following are intentionally **NOT** in the whitelist:

| Command | Reason |
|---------|--------|
| `sed` | Turing-complete scripting language; can write files (`-i`), execute shell commands via `e` flag |
| `awk` / `gawk` | Turing-complete; built-in `system()`, pipe-to-getline (`cmd \| getline`), print-to-pipe (`print > cmd`), file writes |
| `bc` | `!command` escapes to shell |

**Alternative**: Use `grep`, `cut`, `tr`, `head`, `tail`, `jq` for text processing.

---

## Allowed Commands

### Text Processing

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `grep` | None | Unrestricted |
| `egrep` | None | Unrestricted |
| `fgrep` | None | Unrestricted |
| `sort` | `validateSort` | Flags whitelist (see below) |
| `uniq` | `validateUniq` | Max 1 positional arg (no output file) |
| `wc` | None | Unrestricted |
| `head` | None | Unrestricted |
| `tail` | None | Unrestricted |
| `cut` | None | Unrestricted |
| `tr` | None | Unrestricted |
| `jq` | None | Unrestricted |
| `yq` | `validateYq` | Flags whitelist; blocks in-place edit (`-i`) |
| `column` | None | Unrestricted |
| `find` | `validateFind` | Actions and tests whitelist (see below) |

#### sort — allowed flags

```
-r  -n  -k  -t  -u  -f  -h  -V  -s  -b  -g  -M  -d  -i
--reverse  --numeric-sort  --key  --field-separator  --unique
--human-numeric-sort  --version-sort  --stable  --ignore-leading-blanks
--general-numeric-sort  --month-sort  --dictionary-order  --ignore-case
```

Prefixes: `-k<N>`, `-t<char>`, `--key=`, `--field-separator=`

#### yq — allowed flags

```
-r  --raw-output  -e  --exit-status  -o  --output-format
-P  --prettyprint  -C  --colors  -M  --no-colors
-N  --no-doc  -j  --tojson  -p  --input-format
--xml-attribute-prefix  --xml-content-name
-s  --split-exp  --unwrapScalar  --nul-output  --header-preprocess
```

Prefixes: `-o=`, `--output-format=`, `-p=`, `--input-format=`, `--xml-attribute-prefix=`, `--xml-content-name=`

#### find — allowed actions

```
-print  -print0  -ls  -prune  -quit
```

Blocked actions (via whitelist — anything not listed above is blocked):
`-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`, etc.

#### find — allowed tests/options

```
-name  -iname  -path  -ipath  -regex  -iregex
-type  -size  -mtime  -atime  -ctime  -mmin  -amin  -cmin
-newer  -newermt  -newerat  -newerct
-perm  -user  -group  -uid  -gid  -nouser  -nogroup
-empty  -readable  -writable  -executable
-maxdepth  -mindepth  -mount  -xdev
-not  -and  -or  -a  -o
-true  -false  -depth  -daystart
-samefile  -inum  -links  -lname  -ilname
-wholename  -iwholename  -fstype  -xtype
```

---

### Network Diagnostics

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `ip` | `validateIp` | Actions whitelist: `show`, `list`, `ls`, `get` |
| `ifconfig` | `validateIfconfig` | Flags whitelist; max 1 positional (interface name only) |
| `ping` | None | Unrestricted |
| `traceroute` | None | Unrestricted |
| `tracepath` | None | Unrestricted |
| `ss` | None | Unrestricted |
| `netstat` | None | Unrestricted |
| `route` | `validateRoute` | Flags whitelist; no positional args (no add/del) |
| `arp` | `validateArp` | Flags whitelist |
| `ethtool` | `validateEthtool` | Flags whitelist |
| `mtr` | None | Unrestricted |
| `nslookup` | None | Unrestricted |
| `dig` | None | Unrestricted |
| `host` | None | Unrestricted |
| `bridge` | `validateBridge` | Actions whitelist: `show`, `list`, `ls` |
| `tc` | `validateTc` | Actions whitelist: `show`, `list`, `ls` |
| `conntrack` | `validateConntrack` | Ops + flags whitelist |
| `curl` | `validateCurl` | Flags whitelist + HTTP method whitelist |

#### ifconfig — allowed flags

```
-a  -s  --all  --short
```

#### route — allowed flags

```
-n  -e  -v  -F  -C  --numeric  --extend  --verbose
```

#### arp — allowed flags

```
-a  -n  -e  -v  --all  --numeric  --verbose
```

#### ethtool — allowed flags

```
-i  -S  -T  -a  -c  -g  -k  -l  -P  -m  -d  --phy-statistics
```

#### conntrack — allowed operations

```
-L  --dump  -G  --get  -C  --count  -S  --stats  -E  --event
```

#### conntrack — allowed filter flags

```
-p  --proto  -s  --src  -d  --dst  --sport  --dport
-m  --mark  -f  --family  -z  --zero
-o  --output  -e  --event-mask  -b  --buffer-size
-n  --src-nat  -g  --dst-nat
--orig-src  --orig-dst  --reply-src  --reply-dst
--orig-port-src  --orig-port-dst  --reply-port-src  --reply-port-dst
--state  --status  --timeout
```

#### curl — allowed flags

```
-s  --silent  -S  --show-error  -k  --insecure  -v  --verbose
-H  --header  -X  --request  -m  --max-time  --connect-timeout
-L  --location  -I  --head  -w  --write-out
-d  --data  --data-raw  --data-urlencode  --compressed
-A  --user-agent  -b  --cookie  -e  --referer
-u  --user  --cacert  --cert  -x  --proxy
--retry  --retry-delay  --retry-max-time
-f  --fail  -4  -6  -N  --no-buffer
```

#### curl — allowed HTTP methods (with `-X`/`--request`)

```
GET  HEAD  OPTIONS  POST
```

Blocked: `PUT`, `DELETE`, `PATCH`, and any other method.

#### curl — additional restrictions

- `-d`/`--data` with `@file` (file upload) is blocked
- `-o`/`--output` (write to file) is not in the whitelist

---

### RDMA / RoCE

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `ibstat` | None | Unrestricted |
| `ibstatus` | None | Unrestricted |
| `ibv_devinfo` | None | Unrestricted |
| `ibv_devices` | None | Unrestricted |
| `rdma` | `validateRdma` | Actions whitelist: `show`, `list`, `ls` |
| `ibaddr` | None | Unrestricted |
| `iblinkinfo` | None | Unrestricted |
| `ibportstate` | `validateIbportstate` | Actions whitelist: `query` only |
| `ibswitches` | None | Unrestricted |
| `ibroute` | None | Unrestricted |
| `show_gids` | None | Unrestricted |
| `ibdev2netdev` | None | Unrestricted |

---

### Perftest

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `ib_write_bw` | `validatePerftest` | Flags whitelist |
| `ib_write_lat` | `validatePerftest` | Flags whitelist |
| `ib_read_bw` | `validatePerftest` | Flags whitelist |
| `ib_read_lat` | `validatePerftest` | Flags whitelist |
| `ib_send_bw` | `validatePerftest` | Flags whitelist |
| `ib_send_lat` | `validatePerftest` | Flags whitelist |
| `ib_atomic_bw` | `validatePerftest` | Flags whitelist |
| `ib_atomic_lat` | `validatePerftest` | Flags whitelist |
| `raw_ethernet_bw` | `validatePerftest` | Flags whitelist |
| `raw_ethernet_lat` | `validatePerftest` | Flags whitelist |
| `raw_ethernet_burst_lat` | `validatePerftest` | Flags whitelist |

#### perftest — allowed flags

```
-s  --size  -D  --duration  -n  --iters
-p  --port  -d  --ib-dev  -i  --ib-port
-m  --mtu  -x  --gid-index  --sl
-a  --all  -b  --bidirectional
-F  --CPU-freq  -c  --connection
-R  --rdma_cm  -q  --qp
--run_infinitely  --report_gbits  --report_per_port
-l  --post_list  --use_cuda  --use_rocm  --output_format
-h  --help  -V  --version
```

---

### GPU

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `nvidia-smi` | `validateNvidiaSmi` | Flags whitelist; allows `topo`/`nvlink` subcmds |
| `gpustat` | None | Unrestricted |
| `nvtopo` | None | Unrestricted |

#### nvidia-smi — allowed flags

```
-q  --query  -L  --list-gpus  -i
```

Prefixes: `--query-gpu=`, `--query-compute-apps=`, `--id=`, `--format=`, `-i=`

Allowed subcommands: `topo`, `nvlink`

---

### Hardware Info

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `lspci` | None | Unrestricted |
| `lsusb` | None | Unrestricted |
| `lsblk` | None | Unrestricted |
| `lscpu` | None | Unrestricted |
| `lsmem` | None | Unrestricted |
| `lshw` | None | Unrestricted |
| `dmidecode` | None | Unrestricted |

---

### Kernel / System

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `uname` | None | Unrestricted |
| `hostname` | `validateHostname` | Flags whitelist; no positional args (cannot set hostname) |
| `uptime` | None | Unrestricted |
| `dmesg` | `validateDmesg` | Flags whitelist |
| `sysctl` | `validateSysctl` | Flags whitelist; blocks `key=value` writes |
| `lsmod` | None | Unrestricted |
| `modinfo` | None | Unrestricted |

#### hostname — allowed flags

```
-f  -d  -s  -i  -I  -A
--fqdn  --domain  --short  --ip-address  --all-ip-addresses
```

#### dmesg — allowed flags

```
-T  --ctime  -H  --human  -l  --level  -f  --facility
-k  --kernel  -x  --decode  -L  --color  --time-format
-w  --follow  -W  --follow-new  --nopager
--since  --until  -S  --syslog  -t  --notime  -P
```

#### sysctl — allowed flags

```
-a  --all  -n  --values  -e  --ignore
-N  --names  -q  --quiet  -b  --binary
--pattern  -d  --deprecated  -r
```

---

### Process / Resource

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `ps` | None | Unrestricted |
| `pgrep` | None | Unrestricted |
| `top` | `validateTop` | Must use `-b` (batch mode); flags whitelist |
| `free` | None | Unrestricted |
| `vmstat` | None | Unrestricted |
| `iostat` | None | Unrestricted |
| `mpstat` | None | Unrestricted |
| `df` | None | Unrestricted |
| `du` | None | Unrestricted |
| `mount` | `validateMount` | Max 1 positional arg (listing only, no mount operations) |
| `findmnt` | None | Unrestricted |
| `nproc` | None | Unrestricted |

#### top — allowed flags

```
-b  --batch  -n  -d  -p  -H  -c  -o  -O
-w  -1  -e  -E  -i  -S  -s  -u  -U
```

---

### File Inspection (Read-Only)

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `cat` | None | Unrestricted |
| `ls` | None | Unrestricted |
| `pwd` | None | Unrestricted |
| `stat` | None | Unrestricted |
| `file` | None | Unrestricted |
| `readlink` | None | Unrestricted |
| `realpath` | None | Unrestricted |
| `basename` | None | Unrestricted |
| `dirname` | None | Unrestricted |
| `diff` | None | Unrestricted |
| `md5sum` | None | Unrestricted |
| `sha256sum` | None | Unrestricted |

---

### System Logs & Services

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `journalctl` | `validateJournalctl` | Flags whitelist; blocks `-f`/`--follow` (agent-blocking) |
| `systemctl` | `validateSystemctl` | Subcommands whitelist |
| `timedatectl` | `validateTimedatectl` | Subcommands whitelist |
| `hostnamectl` | `validateHostnamectl` | Subcommands whitelist |

#### journalctl — allowed flags

```
-u  --unit  -n  --lines  --since  --until
-p  --priority  -b  --boot  -k  --dmesg
--no-pager  -o  --output  -r  --reverse
-x  --catalog  --system  --user
-t  --identifier  -g  --grep  --case-sensitive
-S  -U  -e  --pager-end  -a  --all
-q  --quiet  --no-hostname  --no-full
-m  --merge  -D  --directory  --file
--list-boots
```

Also allows `KEY=VALUE` field matching (e.g. `_SYSTEMD_UNIT=foo.service`).

#### systemctl — allowed subcommands

```
status  show  list-units  list-unit-files
is-active  is-enabled  is-failed  cat
list-dependencies  list-sockets  list-timers
```

#### timedatectl — allowed subcommands

```
status  show  list-timezones  timesync-status
```

#### hostnamectl — allowed subcommands

```
status  show
```

---

### Container Runtime

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `crictl` | `validateCrictl` | Subcommands whitelist |
| `ctr` | `validateCtr` | Actions whitelist |

#### crictl — allowed subcommands

```
ps  images  inspect  inspecti  inspectp
logs  stats  info  version  pods
```

#### ctr — allowed actions

```
ls  list  info  check
```

Also allows: `ctr version`, `ctr info` as standalone commands.

---

### Firewall (Read-Only)

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `iptables` | `validateIptables` | Flags whitelist |
| `ip6tables` | `validateIptables` | Flags whitelist |

#### iptables/ip6tables — allowed flags

```
-L  --list  -S  --list-rules
-n  --numeric  -v  --verbose
-x  --exact  --line-numbers
-t  --table
```

---

### File / Process Inspection

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `lsof` | None | Unrestricted |
| `lsns` | None | Unrestricted |
| `strings` | None | Unrestricted |

---

### Compressed File Reading

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `zcat` | None | Unrestricted |
| `zgrep` | None | Unrestricted |
| `bzcat` | None | Unrestricted |
| `xzcat` | None | Unrestricted |

---

### System Activity

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `sar` | None | Unrestricted |
| `blkid` | None | Unrestricted |

---

### Stream Utility

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `tee` | `validateTee` | Target whitelist: only `tee` (no args) or `tee /dev/null` |

---

### General

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `date` | `validateDate` | Flags whitelist; blocks set operations |
| `whoami` | None | Unrestricted |
| `id` | None | Unrestricted |
| `env` | `validateEnv` | Blocks command execution; only viewing variables |
| `printenv` | None | Unrestricted |
| `which` | None | Unrestricted |

#### date — allowed flags

```
-d  --date  -u  --utc  --universal
-I  --iso-8601  -R  --rfc-email  --rfc-3339
-r  --reference
```

Also allows format strings starting with `+`.

---

### Flow Control

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `echo` | None | Unrestricted |
| `printf` | None | Unrestricted |
| `true` | None | Unrestricted |
| `false` | None | Unrestricted |
| `sleep` | None | Unrestricted |
| `wait` | None | Unrestricted |
| `test` | None | Unrestricted |

---

### Math

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `expr` | None | Unrestricted |
| `seq` | None | Unrestricted |

---

### SiChek Diagnostics

| Command | Validator | Restrictions |
|---------|-----------|-------------|
| `sichek` | None | Unrestricted |

---

## kubectl Subcommand Whitelist

The `kubectl` tool has its own subcommand whitelist (source: `src/tools/kubectl.ts`):

```
get  describe  logs  top  auth  api-resources
api-versions  explain  version  config  exec
```

Note: `exec` is allowed as a kubectl subcommand but is handled by dedicated tools (`pod-exec`, `pod-script`) with their own validation.

---

## Shell Operator Restrictions

The `restricted-bash` tool validates shell operators before command execution (source: `src/tools/restricted-bash.ts`):

| Operator | Status | Notes |
|----------|--------|-------|
| `\|` (pipe) | Allowed | Each command in pipeline is individually validated |
| `&&` | Allowed | Each command is individually validated |
| `\|\|` | Allowed | Each command is individually validated |
| `;` | Allowed | Each command is individually validated |
| `>` / `>>` | Partial | Only `>/dev/null` and `>>/dev/null` allowed; `>&N` (fd duplication like `2>&1`) allowed |
| `<` | Blocked | Input redirection not allowed |
| `` ` `` | Blocked | Backtick command substitution not allowed |
| `$()` | Blocked | Command substitution not allowed |
| `<()` / `>()` | Blocked | Process substitution not allowed |
| `\n` / `\r` | Blocked | Newline characters not allowed (prevents command smuggling) |
