# YouTube Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install portable `yt-search` and `yt-transcribe` skills that publish deterministic Markdown to `Ecko95/newsletter-curator`, then synchronize changed video records to Notion outside agent conversations.

**Architecture:** `Ecko95/jdu-skills` remains the versioned skill source and `~/.agents/skills` contains canonical symlinks into its checkout. Shared Python helpers prepare and publish exact newsletter artifacts; the newsletter repository owns the GitHub Action and Notion sync. No Gits application code changes.

**Tech Stack:** Python 3.11 stdlib, `yt-dlp`, Bash, Git/GitHub Actions, Notion REST API.

## Global Constraints

- Preserve `transcripts/<title-slug>-<video-id>.md`, `transcripts/searches/search-<YYYY-MM-DD>-<query>.md`, and `transcripts/newsletters/<YYYY-Wnn>.md`.
- Never run `pip --break-system-packages`; install `yt-dlp` once with the existing Hermes `uv` binary.
- Stage and push only files created or updated by the current skill invocation; never force-push.
- Search files never synchronize to Notion; one video ID maps to one idempotently updated Notion item.
- Do not modify `apps/`, `packages/`, or the hosted Gits runtime.

---

## File map

- `/srv/gits/repos/jdu-skills/yt-transcribe/SKILL.md`: portable interaction workflow.
- `/srv/gits/repos/jdu-skills/yt-transcribe/scripts/fetch_transcript.py`: transcript extraction and Markdown generation.
- `/srv/gits/repos/jdu-skills/yt-transcribe/tests/test_fetch_transcript.py`: deterministic parser/output tests.
- `/srv/gits/repos/jdu-skills/yt-search/SKILL.md`: search, selection, and transcription handoff.
- `/srv/gits/repos/jdu-skills/yt-search/scripts/search_youtube.py`: metadata search and Markdown generation.
- `/srv/gits/repos/jdu-skills/yt-search/tests/test_search_youtube.py`: count, parsing, and output tests.
- `/srv/gits/repos/jdu-skills/scripts/newsletter_artifacts.py`: checkout preparation and exact-path publishing.
- `/srv/gits/repos/jdu-skills/tests/test_newsletter_artifacts.py`: isolated Git publishing tests.
- `/srv/gits/repos/newsletter-curator/scripts/sync-transcripts-to-notion.py`: idempotent Git-to-Notion sync.
- `/srv/gits/repos/newsletter-curator/tests/test_sync_transcripts_to_notion.py`: Markdown parsing and create/update fixture tests.
- `/srv/gits/repos/newsletter-curator/.github/workflows/sync-transcripts-to-notion.yml`: cloud trigger.

### Task 1: Prepare isolated source checkouts and dependency

**Files:** None.

**Interfaces:**

- Produces: clean checkouts at `/srv/gits/repos/jdu-skills` and `/srv/gits/repos/newsletter-curator`; `yt-dlp` on `PATH`.

- [ ] **Step 1: Clone without touching existing directories**

```bash
test ! -e /srv/gits/repos/jdu-skills && gh repo clone Ecko95/jdu-skills /srv/gits/repos/jdu-skills
test ! -e /srv/gits/repos/newsletter-curator && gh repo clone Ecko95/newsletter-curator /srv/gits/repos/newsletter-curator
```

Expected: both repositories are on `main` with clean worktrees. If either path exists, inspect and reuse it rather than deleting it.

- [ ] **Step 2: Install `yt-dlp` without modifying system Python**

```bash
/home/ops/.hermes/bin/uv tool install yt-dlp
yt-dlp --version
```

Expected: a version prints and `command -v yt-dlp` succeeds.

### Task 2: Make `yt-transcribe` portable and deterministic

**Files:**

- Modify: `/srv/gits/repos/jdu-skills/yt-transcribe/SKILL.md`
- Modify: `/srv/gits/repos/jdu-skills/yt-transcribe/scripts/fetch_transcript.py`
- Create: `/srv/gits/repos/jdu-skills/yt-transcribe/tests/test_fetch_transcript.py`

**Interfaces:**

- Produces: `parse_vtt(text: str) -> str`, `video_id(url: str) -> str`, and `write_record(info: dict, transcript: str, output_dir: Path) -> Path`.

- [ ] **Step 1: Write failing parser and record tests**

```python
import importlib.util
from pathlib import Path
import sys

MODULE = Path(__file__).parents[1] / "scripts" / "fetch_transcript.py"
SPEC = importlib.util.spec_from_file_location("fetch_transcript", MODULE)
fetch_transcript = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = fetch_transcript
SPEC.loader.exec_module(fetch_transcript)
parse_vtt = fetch_transcript.parse_vtt
video_id = fetch_transcript.video_id
write_record = fetch_transcript.write_record

def test_parse_vtt_removes_timing_tags_and_adjacent_duplicates():
    raw = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c>Hello</c>\nHello\n"
    assert parse_vtt(raw) == "Hello"

def test_video_id_supports_watch_and_short_urls():
    assert video_id("https://youtube.com/watch?v=abc_123") == "abc_123"
    assert video_id("https://youtu.be/abc_123") == "abc_123"

def test_write_record_is_keyed_by_video_id(tmp_path: Path):
    path = write_record({"id": "abc_123", "title": "A Video", "uploader": "Channel", "webpage_url": "https://youtu.be/abc_123"}, "Words", tmp_path)
    assert path.name == "a-video-abc_123.md"
    assert "## Transcript\n\nWords" in path.read_text()
```

- [ ] **Step 2: Run the focused tests and observe failure**

```bash
cd /srv/gits/repos/jdu-skills
python3 -m unittest discover -s yt-transcribe/tests -v
```

Expected: FAIL because the portable functions/module do not exist yet.

- [ ] **Step 3: Implement the minimal portable CLI**

Refactor the existing script to use `shutil.which("yt-dlp")` and raise `RuntimeError("yt-dlp is required")` when absent. Add `--output-dir`; retain subtitle priority: manual English, generated English, manual any language, generated any language. `write_record` must emit:

```markdown
# <title>

- **Video ID:** <id>
- **Channel:** <uploader>
- **Duration:** <duration_string or Unknown>
- **URL:** <webpage_url>
- **Upload Date:** <YYYY-MM-DD or Unknown>
- **Transcribed:** <YYYY-MM-DD>

---

## Transcript

<normalized transcript>
```

Update `SKILL.md` to resolve its own directory, run the script with `--output-dir "$NEWSLETTER_CURATOR_DIR/transcripts"`, present Summary / Action items / Custom prompt, and append chosen analysis to the same record.

- [ ] **Step 4: Run tests and static validation**

```bash
python3 -m unittest discover -s yt-transcribe/tests -v
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /srv/gits/repos/jdu-skills/yt-transcribe
```

Expected: all tests pass and validation reports a valid skill.

- [ ] **Step 5: Commit the transcript port**

```bash
git add yt-transcribe
git commit -m "feat: make yt-transcribe portable"
```

### Task 3: Port `yt-search` and hand selected URLs to transcription

**Files:**

- Modify: `/srv/gits/repos/jdu-skills/yt-search/SKILL.md`
- Create: `/srv/gits/repos/jdu-skills/yt-search/scripts/search_youtube.py`
- Create: `/srv/gits/repos/jdu-skills/yt-search/tests/test_search_youtube.py`

**Interfaces:**

- Produces: `result_count(value: int | None) -> int`, `parse_rows(stdout: str) -> list[Video]`, and `write_search(query: str, videos: list[Video], output_dir: Path) -> Path`.
- Consumes: `yt-transcribe` by skill name for selected URLs.

- [ ] **Step 1: Write failing count and output tests**

```python
import importlib.util
from pathlib import Path
import sys

MODULE = Path(__file__).parents[1] / "scripts" / "search_youtube.py"
SPEC = importlib.util.spec_from_file_location("search_youtube", MODULE)
search_youtube = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = search_youtube
SPEC.loader.exec_module(search_youtube)
Video = search_youtube.Video
result_count = search_youtube.result_count
write_search = search_youtube.write_search

def test_result_count_defaults_and_caps():
    assert result_count(None) == 10
    assert result_count(20) == 20
    assert result_count(99) == 50

def test_search_output_uses_existing_location(tmp_path):
    path = write_search("agent security", [Video("Title", "Channel", "1:00", 42, "20260719", "abc")], tmp_path)
    assert path.parent == tmp_path
    assert "https://www.youtube.com/watch?v=abc" in path.read_text()
```

- [ ] **Step 2: Verify failure, implement, then verify pass**

```bash
python3 -m unittest discover -s yt-search/tests -v
```

Expected before implementation: FAIL. Implement one `yt-dlp "ytsearch<N>:<query>" --flat-playlist` subprocess, tab-separated parsing, safe Markdown table escaping, and `--output-dir`. Run the same command again; expected: PASS.

- [ ] **Step 3: Update and validate the skill**

`SKILL.md` must support `/yt-search <query> [count]` and natural language, save under `$NEWSLETTER_CURATOR_DIR/transcripts/searches`, show results, ask which numbers to transcribe, and invoke `yt-transcribe` for only those URLs.

```bash
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /srv/gits/repos/jdu-skills/yt-search
git add yt-search
git commit -m "feat: port yt-search across agents"
```

### Task 4: Publish only generated newsletter artifacts

**Files:**

- Create: `/srv/gits/repos/jdu-skills/scripts/newsletter_artifacts.py`
- Create: `/srv/gits/repos/jdu-skills/tests/test_newsletter_artifacts.py`
- Modify: both YouTube `SKILL.md` files.

**Interfaces:**

- Produces CLI commands `prepare --repo PATH` and `publish --repo PATH --message TEXT <one-or-more-paths>`.

- [ ] **Step 1: Write a failing isolated Git test**

Create a temporary bare remote and checkout, add both `wanted.md` and unrelated `notes.md`, invoke `publish`, then assert the pushed commit contains only `wanted.md` and `notes.md` remains untracked.

- [ ] **Step 2: Run and observe failure**

```bash
python3 -m unittest tests/test_newsletter_artifacts.py -v
```

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement with stdlib subprocess only**

`prepare` runs `git status --porcelain` and refuses tracked changes, then `git pull --rebase`. `publish` resolves every supplied path beneath the repo, runs `git add -- <exact paths>`, commits only when `git diff --cached --quiet` is false, pushes, and on a non-fast-forward performs one `git pull --rebase` plus push retry. It never runs `git add .`, `git reset`, or force-push.

- [ ] **Step 4: Verify and wire both skills**

```bash
python3 -m unittest tests/test_newsletter_artifacts.py -v
```

Expected: PASS. Update each workflow to call `prepare`, generate its artifact, then call `publish` with the exact returned path.

- [ ] **Step 5: Commit**

```bash
git add scripts tests yt-search/SKILL.md yt-transcribe/SKILL.md
git commit -m "feat: publish newsletter artifacts safely"
git push origin main
```

### Task 5: Add idempotent GitHub-to-Notion synchronization

**Files:**

- Create: `/srv/gits/repos/newsletter-curator/scripts/sync-transcripts-to-notion.py`
- Create: `/srv/gits/repos/newsletter-curator/tests/test_sync_transcripts_to_notion.py`
- Create: `/srv/gits/repos/newsletter-curator/.github/workflows/sync-transcripts-to-notion.yml`

**Interfaces:**

- Produces: `parse_record(path: Path) -> VideoRecord` and `sync_record(record, notion_client) -> "created" | "updated"`.

- [ ] **Step 1: Create or verify the dedicated Notion database**

After reconnecting the Notion app, create a private `YouTube Research` database only if one does not already exist, using this schema:

```sql
CREATE TABLE (
  "Name" TITLE,
  "Video ID" RICH_TEXT,
  "YouTube URL" URL,
  "Channel" RICH_TEXT,
  "Upload Date" DATE,
  "Last Synced" DATE
)
```

Record its data-source/database ID as the `NOTION_DATABASE_ID` GitHub Actions secret. Store the Notion integration token as `NOTION_TOKEN`; never commit either value.

- [ ] **Step 2: Write failing fixture tests**

Tests must prove: metadata and transcript parsing; search/newsletter paths are ignored; an existing `Video ID` result is updated; no result is created; missing `NOTION_TOKEN` or `NOTION_DATABASE_ID` exits non-zero without an HTTP call.

- [ ] **Step 3: Run and observe failure**

```bash
cd /srv/gits/repos/newsletter-curator
python3 -m unittest discover -s tests -v
```

- [ ] **Step 4: Implement with `urllib.request`**

Use Notion API version `2022-06-28`. Query the configured database by exact `Video ID`; create or update properties `Name`, `Video ID`, `YouTube URL`, `Channel`, `Upload Date`, and `Last Synced`. Replace page children with chunked paragraph/heading blocks derived from Transcript, Summary, Action Items, and Custom Analysis sections. Never print secrets.

- [ ] **Step 5: Add the workflow**

```yaml
name: Sync YouTube transcripts to Notion
on:
  push:
    branches: [main]
    paths: ["transcripts/*.md"]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: python3 -m unittest discover -s tests -v
      - run: python3 scripts/sync-transcripts-to-notion.py --changed-from '${{ github.event.before }}'
        env:
          NOTION_TOKEN: "${{ secrets.NOTION_TOKEN }}"
          NOTION_DATABASE_ID: "${{ secrets.NOTION_DATABASE_ID }}"
```

- [ ] **Step 6: Verify, configure secrets, and commit**

```bash
python3 -m unittest discover -s tests -v
printf '%s' "$NOTION_TOKEN" | gh secret set NOTION_TOKEN --repo Ecko95/newsletter-curator
printf '%s' "$NOTION_DATABASE_ID" | gh secret set NOTION_DATABASE_ID --repo Ecko95/newsletter-curator
git add scripts/sync-transcripts-to-notion.py tests/test_sync_transcripts_to_notion.py .github/workflows/sync-transcripts-to-notion.yml
git commit -m "feat: sync YouTube transcripts to Notion"
git push origin main
```

Expected: local fixture tests pass; GitHub workflow will remain configuration-blocked until both repository secrets exist.

### Task 6: Install shared skills and smoke the complete flow

**Files:** Symlinks only under home-directory skill roots.

**Interfaces:** Consumes both validated skills and newsletter checkout.

- [ ] **Step 1: Install canonical and agent links without overwriting**

```bash
mkdir -p /home/ops/.agents/skills /home/ops/.codex/skills /home/ops/.claude/skills /home/ops/.hermes/skills /home/ops/.gits/hermes/skills
ln -s /srv/gits/repos/jdu-skills/yt-search /home/ops/.agents/skills/yt-search
ln -s /srv/gits/repos/jdu-skills/yt-transcribe /home/ops/.agents/skills/yt-transcribe
ln -s /home/ops/.agents/skills/yt-search /home/ops/.codex/skills/yt-search
ln -s /home/ops/.agents/skills/yt-transcribe /home/ops/.codex/skills/yt-transcribe
```

Repeat links for `.claude/skills`, `.hermes/skills`, and `.gits/hermes/skills`, stopping if any destination already exists and resolves elsewhere.

- [ ] **Step 2: Configure the newsletter checkout**

Set `NEWSLETTER_CURATOR_DIR=/srv/gits/repos/newsletter-curator` in the Gits Hermes gateway drop-in and the interactive shell environment used by Codex/Claude/Hermes.

- [ ] **Step 3: Smoke without publishing first**

Run `yt-search` for one result and transcribe one known public video into a temporary directory. Confirm both Markdown shapes and that no media was downloaded.

- [ ] **Step 4: Publish one controlled artifact**

Run the normal skill flow, inspect `git show --name-only HEAD` in newsletter-curator, and confirm only the generated Markdown path was committed.

- [ ] **Step 5: Final validation**

```bash
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /home/ops/.agents/skills/yt-search
python3 /home/ops/.codex/skills/.system/skill-creator/scripts/quick_validate.py /home/ops/.agents/skills/yt-transcribe
```

Expected: both agents discover the same resolved skill directories; the Gits repository remains clean.
