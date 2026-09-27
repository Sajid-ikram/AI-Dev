# Runs inside an agent container for `aidev sandbox-test`; $1 is the marker written to /work.
# Prints one line per check: PASS, FAIL or INFO.

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; }

if [ "$(id -u)" != 0 ]; then pass "runs as a non-root user ($(id -un), uid $(id -u))"; else fail "runs as root"; fi

if su -c true root < /dev/null > /dev/null 2>&1 || sudo -n true > /dev/null 2>&1; then
  fail "can become root"
else
  pass "can't become root with su or sudo"
fi

caps=$(awk '/^CapEff:/ {print $2}' /proc/self/status)
if [ "$caps" = 0000000000000000 ]; then pass "has no Linux capabilities"; else fail "has Linux capabilities ($caps)"; fi

if grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status; then pass "no-new-privileges is on"; else fail "no-new-privileges is off"; fi

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then fail "the Docker socket is mounted"; else pass "no Docker socket"; fi

if [ "$(cat /work/.aidev-sandbox-marker 2> /dev/null)" = "$1" ]; then pass "sees its job folder at /work"; else fail "the job folder isn't mounted at /work"; fi
if touch /work/.write-test 2> /dev/null && rm /work/.write-test; then pass "can write to /work"; else fail "can't write to /work"; fi

extra=$(awk '{print $2}' /proc/mounts | sort -u \
  | grep -Ev '^(/|/proc(/.*)?|/sys(/.*)?|/dev(/.*)?|/etc/(resolv\.conf|hostname|hosts)|(/usr)?/sbin/docker-init|/work|/claude)$' | tr '\n' ' ')
if [ -z "$extra" ]; then pass "only the job folders are mounted from the host"; else fail "unexpected mounts: $extra"; fi

hostpaths=""
for p in /mnt/c /mnt/host /mnt/wsl /host_mnt /run/desktop /c /Users /Windows; do
  [ -e "$p" ] && hostpaths="$hostpaths $p"
done
if [ -z "$hostpaths" ]; then pass "none of the usual host-drive paths exist (/mnt/c, /host_mnt, /run/desktop...)"; else fail "host paths exist:$hostpaths"; fi

found=$(find / \( -path /proc -o -path /sys -o -path /work -o -path /claude \) -prune -o \
  -type d \( -name Users -o -name 'Program Files' -o -path '*/Windows/System32' \) -print 2> /dev/null | head -5 | tr '\n' ' ')
if [ -z "$found" ]; then pass "no Windows folders (Users, Program Files, Windows/System32) anywhere"; else fail "found Windows folders: $found"; fi

leaked=$(env | cut -d= -f1 | grep -E '^(JIRA_|BITBUCKET_|AIDEV_|GITHUB_|GH_|AWS_)' | tr '\n' ' ')
if [ -z "$leaked" ]; then pass "no Jira, Bitbucket or other tool credentials in the environment"; else fail "credentials in the environment: $leaked"; fi
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
  fail "both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set; the API key would win"
else
  pass "at most one Claude credential is set"
fi

mem=$(cat /sys/fs/cgroup/memory.max 2> /dev/null)
if [ -n "$mem" ] && [ "$mem" != max ]; then pass "memory is capped at $((mem / 1048576)) MiB"; else fail "memory isn't capped"; fi
pids=$(cat /sys/fs/cgroup/pids.max 2> /dev/null)
if [ -n "$pids" ] && [ "$pids" != max ]; then pass "processes are capped at $pids"; else fail "the process count isn't capped"; fi

if getent hosts host.docker.internal > /dev/null 2>&1; then
  echo "INFO host.docker.internal resolves, so the container can reach network services on the PC. Phase 4 adds an egress allowlist."
fi
