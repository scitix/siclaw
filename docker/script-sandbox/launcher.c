/* Install an inherited Linux syscall allowlist before loading any user code.
 * No libseccomp, root, custom node profile or CNI plugin is required.
 * Unknown ABI/syscalls fail closed. This is additional container hardening,
 * not protection against all kernel vulnerabilities.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <dirent.h>
#include <limits.h>

#define ALLOW(name) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##name, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#if defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported script runner architecture
#endif

static int isolate(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        ALLOW(read), ALLOW(write), ALLOW(readv), ALLOW(writev), ALLOW(close),
        ALLOW(openat), ALLOW(newfstatat), ALLOW(fstat), ALLOW(lseek),
        ALLOW(pread64), ALLOW(pwrite64), ALLOW(fcntl), ALLOW(flock),
        ALLOW(mmap), ALLOW(mprotect), ALLOW(munmap), ALLOW(mremap), ALLOW(brk), ALLOW(madvise),
        ALLOW(rt_sigaction), ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn), ALLOW(sigaltstack),
        ALLOW(rt_sigtimedwait), ALLOW(rt_sigsuspend), ALLOW(kill), ALLOW(tgkill),
        ALLOW(getpid), ALLOW(getppid), ALLOW(gettid), ALLOW(getuid), ALLOW(geteuid),
        ALLOW(getgid), ALLOW(getegid), ALLOW(getgroups),
#ifdef __NR_getpgrp
        ALLOW(getpgrp),
#endif
        ALLOW(getpgid), ALLOW(setpgid), ALLOW(getsid), ALLOW(setsid),
        ALLOW(getcwd), ALLOW(chdir), ALLOW(fchdir), ALLOW(umask),
        ALLOW(getdents64), ALLOW(readlinkat), ALLOW(unlinkat), ALLOW(mkdirat),
        ALLOW(renameat), ALLOW(fchmod), ALLOW(fchmodat), ALLOW(ftruncate),
        ALLOW(fsync), ALLOW(fdatasync), ALLOW(utimensat), ALLOW(statfs), ALLOW(fstatfs),
        ALLOW(faccessat), ALLOW(dup), ALLOW(dup3), ALLOW(pipe2),
        ALLOW(pselect6), ALLOW(ppoll), ALLOW(epoll_create1), ALLOW(epoll_ctl), ALLOW(epoll_pwait),
        ALLOW(clock_gettime), ALLOW(clock_getres), ALLOW(clock_nanosleep), ALLOW(nanosleep),
        ALLOW(gettimeofday), ALLOW(times), ALLOW(getrusage), ALLOW(sysinfo), ALLOW(uname),
        ALLOW(sched_yield), ALLOW(sched_getaffinity), ALLOW(futex), ALLOW(set_tid_address),
        ALLOW(set_robust_list), ALLOW(get_robust_list), ALLOW(prlimit64), ALLOW(getrlimit),
        ALLOW(getrandom), ALLOW(wait4), ALLOW(waitid), ALLOW(execve), ALLOW(exit), ALLOW(exit_group),
#ifdef __NR_rseq
        ALLOW(rseq),
#endif
#ifdef __NR_close_range
        ALLOW(close_range),
#endif
#ifdef __NR_statx
        ALLOW(statx),
#endif
#ifdef __NR_faccessat2
        ALLOW(faccessat2),
#endif
#ifdef __NR_renameat2
        ALLOW(renameat2),
#endif
#ifdef __x86_64__
        ALLOW(open), ALLOW(stat), ALLOW(lstat), ALLOW(access), ALLOW(readlink),
        ALLOW(unlink), ALLOW(mkdir), ALLOW(rmdir), ALLOW(rename), ALLOW(chmod),
        ALLOW(dup2), ALLOW(pipe), ALLOW(poll), ALLOW(select), ALLOW(epoll_wait),
        ALLOW(arch_prctl), ALLOW(fork), ALLOW(vfork), ALLOW(time),
#endif
        /* clone3 has pointer arguments which classic seccomp cannot inspect.
         * ENOSYS lets libc fall back to clone with inspectable flag arguments. */
#ifdef __NR_clone3
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        /* Reject all namespace creation flags, including CLONE_NEWUSER. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x7e020000U, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        /* Tty queries and close-on-exec for Python file opens. FIOCLEX changes
         * only the descriptor flag (also available via fcntl), not a device. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 6),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5401, 3, 0), /* TCGETS */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5413, 2, 0), /* TIOCGWINSZ */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5451, 1, 0), /* FIOCLEX */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* No socket/socketcall, io_uring, ptrace, process_vm_*, pidfd_getfd,
         * bpf, mount, namespace entry, credential changes or kernel modules. */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    };
    struct sock_fprog program = { (unsigned short)(sizeof(filter) / sizeof(filter[0])), filter };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
#endif

int main(int argc, char **argv) {
    if (argc < 3 || (strcmp(argv[1], "isolated") && strcmp(argv[1], "standard"))) {
        fputs("Usage: siclaw-launcher isolated|standard COMMAND [ARGS...]\n", stderr);
        return 125;
    }
#ifdef __linux__
    /* OCI-created stdin/stdout/stderr must be pipes. Never inherit extra fds. */
    for (int fd = 0; fd < 3; ++fd) {
        struct stat st;
        if (fstat(fd, &st) != 0 || S_ISSOCK(st.st_mode)) return 125;
    }
    /* Avoid up to a million close() calls on each cold start. */
#ifdef __NR_close_range
    if (syscall(__NR_close_range, 3U, UINT_MAX, 0U) != 0)
#endif
    {
        DIR *fds = opendir("/proc/self/fd");
        if (!fds) return 125;
        struct dirent *entry;
        while ((entry = readdir(fds))) {
            char *end;
            long fd = strtol(entry->d_name, &end, 10);
            if (!*end && fd >= 3 && fd != dirfd(fds)) close((int)fd);
        }
        closedir(fds);
    }
    struct rlimit processes = {128, 128};
    struct rlimit files = {256, 256};
    struct rlimit core = {0, 0};
    if (setrlimit(RLIMIT_NPROC, &processes) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) return 125;
    /* Also forbid privilege gains when optional socket isolation is disabled. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 125;
    if (clearenv() != 0 || setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) != 0 ||
        setenv("LANG", "C.UTF-8", 1) != 0 || setenv("HOME", "/work", 1) != 0) return 125;
    if (!strcmp(argv[1], "isolated") && isolate() != 0) {
        fputs("Network isolation could not be installed; refusing execution\n", stderr);
        return 125;
    }
    execvp(argv[2], &argv[2]);
    fputs("Script interpreter could not be started\n", stderr);
    return 125;
#else
    fputs("Script runner requires Linux container isolation\n", stderr);
    return 125;
#endif
}
