#!/usr/bin/env bash
# run-spike.sh — exercises gits-confine.sh against the H0 threat model and prints a PASS/FAIL table.
#
# Threat model (H0): an attacker controls the contents of a peer's worktree (hostile repo:
# README, code, test fixtures, npm lifecycle scripts). We must prove that, when run confined:
#   - real $HOME secrets are INVISIBLE                       (no exfiltration)
#   - writes outside the worktree are BLOCKED               (no host tampering)
#   - npm lifecycle scripts do NOT run (--ignore-scripts)   (no install-time RCE)
#   - even a script that DOES run is contained              (defense in depth)
#   - the network is OFF                                    (no exfil channel)
#   - legitimate work + verification inside the worktree still succeed (usability)
#
# An UNCONFINED control runs first to prove the attack is real (not a no-op) on this host.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFINE="$HERE/gits-confine.sh"
SENTINEL="$HOME/.gits-h0-spike-sentinel-SECRET.txt"
SENTINEL_VALUE="TOP-SECRET-DO-NOT-EXFIL-$$-$RANDOM"
WT=""
PASS=0; FAIL=0

cleanup() { rm -f "$SENTINEL"; [ -n "$WT" ] && rm -rf "$WT"; }
trap cleanup EXIT

ok()   { printf '  \033[32mPASS\033[0m  %-46s %s\n' "$1" "${2:-}"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %-46s %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$*"; }

command -v bwrap >/dev/null 2>&1 || { echo "bwrap not installed — cannot run spike"; exit 70; }
chmod +x "$CONFINE"

# --- fixture: a hostile worktree (under $HOME so the worktree's PARENT is unbound in the sandbox) ---
WT="$(mktemp -d -p "$HOME" gits-h0-wt.XXXXXX)"
printf '%s\n' "$SENTINEL_VALUE" > "$SENTINEL"   # a fake secret in REAL $HOME (cleaned up on exit)

cat > "$WT/probe.sh" <<PROBE
#!/usr/bin/env sh
# Hostile probe: attempts every escape and reports outcomes into the (writable) worktree.
echo "uid=\$(id -u) home=\$HOME pwd=\$(pwd)"                            >  ./probe-report.txt
echo "--- read real-home sentinel via absolute path ---"               >> ./probe-report.txt
if cat "$SENTINEL" 2>/dev/null >> ./probe-report.txt; then
  echo "SENTINEL_READ=YES" >> ./probe-report.txt
else
  echo "SENTINEL_READ=NO"  >> ./probe-report.txt
fi
echo "--- list \$HOME ---"                                              >> ./probe-report.txt
ls -a "\$HOME" 2>&1 | tr '\n' ' '                                      >> ./probe-report.txt; echo >> ./probe-report.txt
echo "--- write to read-only system mount (/etc) ---"                  >> ./probe-report.txt
if echo pwned > /etc/PWNED-h0 2>/dev/null; then
  echo "ETC_WRITE=YES" >> ./probe-report.txt
else
  echo "ETC_WRITE=NO"  >> ./probe-report.txt
fi
echo "--- write to real-home sibling (expect: absorbed by ephemeral root, never on host) ---" >> ./probe-report.txt
if echo pwned > "$HOME/PWNED-real-home" 2>/dev/null; then
  echo "WRITE_OUTSIDE=YES" >> ./probe-report.txt
else
  echo "WRITE_OUTSIDE=NO"  >> ./probe-report.txt
fi
echo "--- write inside worktree ---"                                   >> ./probe-report.txt
if echo ok > ./inside-write.txt 2>/dev/null; then
  echo "WRITE_INSIDE=YES" >> ./probe-report.txt
else
  echo "WRITE_INSIDE=NO"  >> ./probe-report.txt
fi
PROBE
chmod +x "$WT/probe.sh"

cat > "$WT/verify.js" <<'VERIFY'
// Benign verification: the kind of thing a real gate runs. Must succeed confined.
const os = require("node:os");
console.log("verify.js ran: node", process.version, "home", os.homedir());
process.exit(0);
VERIFY

cat > "$WT/malicious-preinstall.sh" <<'MAL'
#!/usr/bin/env sh
echo "MALICIOUS-PREINSTALL-EXECUTED" > ./PWNED-PREINSTALL.txt
MAL
chmod +x "$WT/malicious-preinstall.sh"

cat > "$WT/package.json" <<'PKG'
{ "name": "h0-fixture", "version": "1.0.0", "private": true,
  "scripts": { "preinstall": "sh ./malicious-preinstall.sh", "verify": "node verify.js" } }
PKG

echo
echo "H0 confinement spike — bwrap $(bwrap --version 2>/dev/null | awk '{print $2}')"
echo "worktree: $WT"
echo "sentinel: $SENTINEL"
echo

# --- 0) UNCONFINED CONTROL: prove the attack actually works on this host ------------------
echo "[control] unconfined probe (proves the attack is real, not a no-op):"
( cd "$WT" && sh ./probe.sh )
ctl="$(cat "$WT/probe-report.txt")"
if echo "$ctl" | grep -q "SENTINEL_READ=YES"; then ok "control: unconfined CAN read the secret" "(attack is real)";
  else bad "control: unconfined should read the secret" "(test fixture broken?)"; fi
rm -f "$HOME/PWNED-real-home" "$WT/probe-report.txt" "$WT/inside-write.txt"
echo

# --- CONFINED RUNS -----------------------------------------------------------------------
echo "[confined] running probe under gits-confine.sh (net off):"
timeout 30 "$CONFINE" --worktree "$WT" --label probe -- sh ./probe.sh >/dev/null 2>&1
rep="$(cat "$WT/probe-report.txt" 2>/dev/null || echo "")"
note "report: $(echo "$rep" | tr '\n' '|')"

echo "$rep" | grep -q "SENTINEL_READ=NO"  && ok "A. real-\$HOME secret invisible"            "(SENTINEL_READ=NO)"  || bad "A. real-\$HOME secret invisible"  "secret was readable!"
echo "$rep" | grep -q "ETC_WRITE=NO"      && ok "C. write to read-only system mount blocked" "(/etc denied)"       || bad "C. write to read-only system mount blocked" "wrote to /etc!"
echo "$rep" | grep -q "WRITE_INSIDE=YES"  && ok "D. write inside worktree allowed"           "(WRITE_INSIDE=YES)"  || bad "D. write inside worktree allowed"  "could not write worktree"
[ ! -e "$HOME/PWNED-real-home" ]          && ok "C2. no host escape: real \$HOME untouched"  "(ephemeral root absorbed it)" || { bad "C2. host escape: PWNED in real \$HOME" ""; rm -f "$HOME/PWNED-real-home"; }
[ -e "$WT/inside-write.txt" ]             && ok "D2. worktree write visible on host after"   ""                    || bad "D2. worktree write visible on host" "missing"

# --- E) network off blocks egress ---------------------------------------------------------
netcode=$(timeout 30 "$CONFINE" --worktree "$WT" --label net -- node -e '
const c=new AbortController(); const t=setTimeout(()=>c.abort(),4000);
fetch("https://example.com",{signal:c.signal}).then(()=>{clearTimeout(t);process.exit(9);}).catch(()=>{clearTimeout(t);process.exit(0);});
' >/dev/null 2>&1; echo $?)
[ "$netcode" = "0" ] && ok "E. network off (egress blocked)" "(fetch failed as expected)" || bad "E. network off (egress blocked)" "fetch succeeded / unexpected code $netcode"

# --- F) npm --ignore-scripts neutralizes the malicious preinstall -------------------------
rm -f "$WT/PWNED-PREINSTALL.txt"
timeout 60 "$CONFINE" --worktree "$WT" --label npm -- npm install --no-audit --no-fund --offline >/dev/null 2>&1 || true
[ ! -e "$WT/PWNED-PREINSTALL.txt" ] && ok "F. npm lifecycle script did NOT run" "(--ignore-scripts forced)" || bad "F. npm lifecycle script ran" "preinstall executed!"

# --- G) defense-in-depth: even a script that DOES run is contained -------------------------
rm -f "$WT/probe-report.txt" "$HOME/PWNED-real-home"
timeout 30 "$CONFINE" --worktree "$WT" --label exec-script -- sh ./malicious-preinstall.sh >/dev/null 2>&1 || true
ranfile=$([ -e "$WT/PWNED-PREINSTALL.txt" ] && echo yes || echo no)
[ "$ranfile" = "yes" ] && [ ! -e "$HOME/PWNED-real-home" ] && ok "G. executed script contained to worktree" "(ran, but no host escape)" || note "G. (script exec=$ranfile; escape check via A/C above)"

# --- H) positive usability: verification runs confined ------------------------------------
vcode=$(timeout 30 "$CONFINE" --worktree "$WT" --label verify -- node verify.js >/dev/null 2>&1; echo $?)
[ "$vcode" = "0" ] && ok "H. benign verification runs confined" "(node verify.js exit 0)" || bad "H. benign verification runs confined" "exit $vcode"

echo
echo "================  $PASS passed / $FAIL failed  ================"
[ "$FAIL" -eq 0 ] && echo "H0 confinement spike: VIABLE on this host." || echo "H0 confinement spike: investigate failures above."
exit "$FAIL"
