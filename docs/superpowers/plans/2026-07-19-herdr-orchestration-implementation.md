# Herdr Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex, Claude, and Hermes inspect and coordinate Herdr agents safely, including trusted headless access from the Gits-managed Hermes Telegram gateway.

**Architecture:** The existing `herdr` skill remains the low-level CLI authority and gains one explicit headless prerequisite. A new versioned `herdr-orchestration` companion in `Ecko95/jdu-skills` supplies coordination workflows and deterministic socket ownership verification. The managed Hermes gateway gets the opt-in through a systemd drop-in; Gits application policy and code remain unchanged.

**Tech Stack:** Herdr CLI/socket API, Python 3.11 stdlib, systemd user services, Agent Skills Markdown.

## Global Constraints

- Existing resources may be inspected, messaged, and waited on; close/delete only exact IDs created during the current orchestration task.
- Never stop/delete the default Herdr session, construct IDs, use UI focus as a target, or force a headless process to pretend it owns a pane.
- Keep `~/.gits/hermes` as the sole persistent Telegram profile; do not start a personal Hermes gateway.
- Do not change Gits `observe-propose-only` application code.

---

## File map

- `/home/ops/.agents/skills/herdr/SKILL.md`: low-level pane/headless entry rules.
- `/srv/gits/repos/jdu-skills/herdr-orchestration/SKILL.md`: orchestration workflow and safety policy.
- `/srv/gits/repos/jdu-skills/herdr-orchestration/scripts/verify_headless.py`: default-session socket verification.
- `/srv/gits/repos/jdu-skills/herdr-orchestration/tests/test_verify_headless.py`: deterministic guard tests.
- `/srv/gits/repos/jdu-skills/herdr-orchestration/tests/scenarios.md`: behavioral acceptance prompts.
- `/home/ops/.config/systemd/user/hermes-gateway.service.d/herdr.conf`: managed gateway opt-in.

### Task 1: Add a tested trusted-headless guard

**Files:**

- Create: `/srv/gits/repos/jdu-skills/herdr-orchestration/scripts/verify_headless.py`
- Create: `/srv/gits/repos/jdu-skills/herdr-orchestration/tests/test_verify_headless.py`

**Interfaces:** Produces `require_opt_in(env: Mapping[str, str]) -> None`, `verify(session_json: str, uid: int) -> Path`, and a CLI that prints the verified socket path.

- [ ] **Step 1: Write failing tests**

```python
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

MODULE = Path(__file__).parents[1] / "scripts" / "verify_headless.py"
SPEC = importlib.util.spec_from_file_location("verify_headless", MODULE)
verify_headless = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = verify_headless
SPEC.loader.exec_module(verify_headless)

class VerifyHeadlessTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.socket_path = Path(self.tempdir.name) / "herdr.sock"
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.bind(str(self.socket_path))

    def tearDown(self):
        self.sock.close()
        self.tempdir.cleanup()

    def payload(self, *, default=True, running=True):
        return json.dumps({"sessions": [{
            "name": "default" if default else "other",
            "default": default,
            "running": running,
            "socket_path": str(self.socket_path),
        }]})

    def test_rejects_without_opt_in(self):
        with self.assertRaises(PermissionError):
            verify_headless.require_opt_in({})

    def test_accepts_running_default_owned_socket(self):
        actual = verify_headless.verify(self.payload(), os.getuid())
        self.assertEqual(actual, self.socket_path)

    def test_rejects_non_default_session(self):
        with self.assertRaises(RuntimeError):
            verify_headless.verify(self.payload(default=False), os.getuid())

    def test_rejects_foreign_owned_socket(self):
        with self.assertRaises(PermissionError):
            verify_headless.verify(self.payload(), os.getuid() + 1)
```

- [ ] **Step 2: Run and observe failure**

```bash
python3 -m unittest discover -s /srv/gits/repos/jdu-skills/herdr-orchestration/tests -v
```

- [ ] **Step 3: Implement minimal verification**

The CLI requires `HERDR_HEADLESS=1`, runs `herdr session list --json`, selects the running default session, verifies `stat.S_ISSOCK(mode)` and `st_uid == os.getuid()`, then prints the socket path. Any failure exits non-zero with a non-secret explanation.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m unittest discover -s /srv/gits/repos/jdu-skills/herdr-orchestration/tests -v
git -C /srv/gits/repos/jdu-skills add herdr-orchestration
git -C /srv/gits/repos/jdu-skills commit -m "feat: verify headless Herdr access"
```

### Task 2: Write and validate `herdr-orchestration`

**Files:**

- Create: `/srv/gits/repos/jdu-skills/herdr-orchestration/SKILL.md`
- Create: `/srv/gits/repos/jdu-skills/herdr-orchestration/agents/openai.yaml`

**Interfaces:** Requires the `herdr` skill; exposes inspect, read-chat, message, spawn, wait, summarize, and owned-cleanup workflows.

- [ ] **Step 1: Record failing behavioral checks**

Create `tests/scenarios.md` with these exact acceptance cases:

```markdown
# Herdr orchestration scenarios

1. “Summarize every live workspace and agent.” → list explicit IDs and states; make no mutations.
2. “Ask blocked pane <existing-id> what input it needs.” → read first, send one explicit follow-up, then wait.
3. “Start a Codex reviewer.” → split without focus, record the returned pane ID as owned, launch, prompt, wait, and read.
4. “Close <pre-existing-id>.” → refuse because the current task did not create it.
5. “Stop the default Herdr session.” → refuse unconditionally.
```

- [ ] **Step 2: Write the minimal skill**

The description triggers only on coordinating multiple Herdr sessions/chats/agents. The body must require `herdr`, distinguish pane-local from verified headless mode, discover command syntax before use, capture exact created IDs in a turn-local owned set, and implement:

```text
inspect -> resolve explicit IDs -> read current state -> act -> verify transition -> read result
```

Headless mode bans `--current`; pane-local mode prefers it only for the caller pane. Existing panes allow `list/get/read/run/wait`; only owned IDs allow `close`.

- [ ] **Step 3: Generate metadata and validate**

```bash
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/generate_openai_yaml.py /srv/gits/repos/jdu-skills/herdr-orchestration --interface display_name="Herdr Orchestration" --interface short_description="Coordinate Herdr sessions, chats, and agents safely" --interface default_prompt="Inspect the current Herdr activity and coordinate the requested agents safely."
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /srv/gits/repos/jdu-skills/herdr-orchestration
```

- [ ] **Step 4: Commit**

```bash
git -C /srv/gits/repos/jdu-skills add herdr-orchestration
git -C /srv/gits/repos/jdu-skills commit -m "feat: add Herdr orchestration skill"
git -C /srv/gits/repos/jdu-skills push origin main
```

### Task 3: Extend the existing low-level `herdr` skill without weakening pane safety

**Files:** Modify `/home/ops/.agents/skills/herdr/SKILL.md`.

**Interfaces:** Consumes the verifier from Task 1.

- [ ] **Step 1: Demonstrate the current failure**

```bash
env -u HERDR_ENV HERDR_HEADLESS=1 sh -c 'test "${HERDR_ENV:-}" = 1'
```

Expected: non-zero; current instructions stop all non-pane callers.

- [ ] **Step 2: Add the two-mode prerequisite**

Preserve the existing `HERDR_ENV=1` pane path verbatim. Add a second path: when `HERDR_HEADLESS=1`, run `verify_headless.py`; permit only explicit IDs and ban every `--current` example. If neither mode verifies, stop.

- [ ] **Step 3: Validate the edited skill**

```bash
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /home/ops/.agents/skills/herdr
HERDR_HEADLESS=1 python3 /srv/gits/repos/jdu-skills/herdr-orchestration/scripts/verify_headless.py
```

Expected: validation passes and the second command prints `/home/ops/.config/herdr/herdr.sock`.

### Task 4: Install agent links and Hermes status integration

**Files:** Symlinks in agent skill roots and Hermes plugin roots.

**Interfaces:** Produces one resolved orchestration skill for Codex, Claude, and both Hermes profiles.

- [ ] **Step 1: Create the canonical link**

```bash
ln -s /srv/gits/repos/jdu-skills/herdr-orchestration /home/ops/.agents/skills/herdr-orchestration
```

Stop if the destination exists and resolves elsewhere.

- [ ] **Step 2: Link each agent root**

Link `/home/ops/.agents/skills/herdr-orchestration` into `.codex/skills`, `.claude/skills`, `.hermes/skills`, and `.gits/hermes/skills`. Also link the existing `/home/ops/.agents/skills/herdr` into `.gits/hermes/skills/herdr`; preserve already-correct links.

- [ ] **Step 3: Install and expose Hermes status reporting**

```bash
herdr integration install hermes
herdr integration status
```

Expected: Hermes reports current. If the installer writes only to `~/.hermes/plugins/herdr-agent-state`, create a non-overwriting symlink at `~/.gits/hermes/plugins/herdr-agent-state` to the installed plugin and restart only the managed gateway later.

### Task 5: Enable headless access only for managed Hermes

**Files:** Create `/home/ops/.config/systemd/user/hermes-gateway.service.d/herdr.conf`.

**Interfaces:** Supplies `HERDR_HEADLESS=1` and the newsletter checkout path to the Gits-managed Hermes gateway.

- [ ] **Step 1: Create the drop-in**

```ini
[Service]
Environment=HERDR_HEADLESS=1
Environment=NEWSLETTER_CURATOR_DIR=/srv/gits/repos/newsletter-curator
```

- [ ] **Step 2: Reload and restart only the managed gateway**

```bash
systemctl --user daemon-reload
systemctl --user restart hermes-gateway.service
systemctl --user show hermes-gateway.service -p ActiveState -p SubState -p MainPID
```

Expected: active/running. Do not change or restart `gits-cockpit.service`.

### Task 6: Diagnose Telegram ownership and smoke orchestration

**Files:** None unless an already-known competing local service is found.

**Interfaces:** Validates sole managed poller and end-to-end Herdr control.

- [ ] **Step 1: Enumerate local pollers without exposing tokens**

```bash
ps -u ops -o pid,ppid,cmd | grep -E 'hermes_cli.*gateway run|hermes gateway' | grep -v grep
systemctl --user list-units --type=service --all | grep -i hermes
```

Expected: exactly `hermes-gateway.service` using `HERMES_HOME=/home/ops/.gits/hermes`. Stop another local poller only if its identity is exact and it is clearly the personal Hermes gateway; never kill an unknown process.

- [ ] **Step 2: Check Telegram logs**

```bash
journalctl --user -u hermes-gateway.service --since '-5 minutes' --no-pager | grep -i 'polling conflict' || true
```

If conflicts persist with one local poller, report an external/remote poller; do not rotate the bot token without separate authorization.

- [ ] **Step 3: Run an isolated Herdr orchestration smoke**

Use a named non-default test session. Inspect it, create one pane, launch a normal interactive agent, send a harmless status prompt, wait for completion, read output, and close only the pane created in this task. Confirm the default session remains running.

- [ ] **Step 4: Final validation**

```bash
python3 -m unittest discover -s /srv/gits/repos/jdu-skills/herdr-orchestration/tests -v
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /home/ops/.agents/skills/herdr-orchestration
herdr integration status
herdr session list --json
git -C /srv/gits/repos/gitscode status --short
```

Expected: tests and validation pass, Hermes integration is current, default Herdr remains running, and Gits contains no implementation changes beyond approved documentation.
