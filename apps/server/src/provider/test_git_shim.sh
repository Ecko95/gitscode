#!/bin/sh
# test_git_shim.sh — policy self-check for git-shim.sh
# Run: sh test_git_shim.sh
# A fake "git" that records its args is injected as GITS_REAL_GIT.

set -eu

SHIM="$(cd "$(dirname "$0")" && pwd)/assets/git-shim.sh"
if [ ! -f "$SHIM" ]; then
	echo "FAIL: shim not found at $SHIM" >&2
	exit 1
fi

TMPDIR="${TMPDIR:-/tmp}"
FAKE_GIT="$TMPDIR/test_shim_fake_git_$$"
ALLOWED_DIR="$TMPDIR/test_shim_allowed_$$"
OUTSIDE_DIR="$TMPDIR/test_shim_outside_$$"

mkdir -p "$ALLOWED_DIR" "$OUTSIDE_DIR"

# Fake git: exit 0 and record invocation to stdout.
cat > "$FAKE_GIT" <<'EOF'
#!/bin/sh
echo "REAL_GIT_CALLED $*"
EOF
chmod +x "$FAKE_GIT"

PASS=0
FAIL=0

check() {
	local label="$1"
	local expected_exit="$2"
	local expected_grep="$3"
	shift 3
	local out
	local code=0
	out=$(GITS_REAL_GIT="$FAKE_GIT" GITS_ALLOWED_ROOT="$ALLOWED_DIR" GITS_PROTECTED_BRANCHES="main,master,gits" sh "$SHIM" "$@" 2>&1) || code=$?
	if [ "$code" != "$expected_exit" ]; then
		echo "FAIL [$label]: expected exit $expected_exit got $code. Output: $out"
		FAIL=$((FAIL + 1))
		return
	fi
	if [ -n "$expected_grep" ] && ! echo "$out" | grep -q "$expected_grep"; then
		echo "FAIL [$label]: expected '$expected_grep' in output: $out"
		FAIL=$((FAIL + 1))
		return
	fi
	echo "PASS [$label]"
	PASS=$((PASS + 1))
}

# 1. merge denied
check "merge denied" 128 "denied" merge main

# 2. rebase denied
check "rebase denied" 128 "denied" rebase origin/main

# 3. force-push to main denied
check "force-push main denied" 128 "denied" push origin main --force

# 4. force-push to gits denied
check "force-push gits denied" 128 "denied" push origin gits -f

# 5. regular push to non-protected branch passes through (must run from allowed root)
(cd "$ALLOWED_DIR" && check "push feature allowed" 0 "REAL_GIT_CALLED" push origin feature/foo)

# 6. read-only log passes through
check "log passthrough" 0 "REAL_GIT_CALLED" log --oneline

# 7. status passes through
check "status passthrough" 0 "REAL_GIT_CALLED" status

# 8. write op inside allowed root passes
(cd "$ALLOWED_DIR" && check "commit inside root" 0 "REAL_GIT_CALLED" commit -m "test")

# 9. write op outside allowed root denied
(cd "$OUTSIDE_DIR" && check "commit outside root denied" 128 "denied" commit -m "test")

# 10. worktree add denied
check "worktree add denied" 128 "denied" worktree add /tmp/somewhere HEAD

# 11. remote add denied
check "remote add denied" 128 "denied" remote add origin https://example.com

# 12. config --global denied
check "config global denied" 128 "denied" config --global user.email foo@bar

# 13. config --system denied
check "config system denied" 128 "denied" config --system user.name foo

# 14. config local (non-global) passes through (write op, cwd checked)
(cd "$ALLOWED_DIR" && check "config local allowed" 0 "REAL_GIT_CALLED" config user.email foo@bar)

# 15. GITS_REAL_GIT unset → error (check() always sets GITS_REAL_GIT; test inline instead)
out=$(GITS_REAL_GIT="" sh "$SHIM" status 2>&1) || true
if echo "$out" | grep -q "GITS_REAL_GIT not set"; then
	echo "PASS [GITS_REAL_GIT unset]"
	PASS=$((PASS + 1))
else
	echo "FAIL [GITS_REAL_GIT unset]: expected GITS_REAL_GIT not set. Got: $out"
	FAIL=$((FAIL + 1))
fi

# Cleanup
rm -f "$FAKE_GIT"
rm -rf "$ALLOWED_DIR" "$OUTSIDE_DIR"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
