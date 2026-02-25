/**
 * GitHub Weekly Summary template — file constants.
 *
 * Extracted from the working agent at agents/github-weekly-summary/.
 * Python files are EXACT copies. orchagent.json and README.md use {{name}} substitution.
 */

// ─── orchagent.json ──────────────────────────────────────────────────────────

export const TEMPLATE_MANIFEST = `{
  "name": "{{name}}",
  "version": "v1",
  "type": "agent",
  "description": "Weekly GitHub activity summary delivered to Discord. Uses Claude to analyse commits, PRs, and issues — surfaces patterns, risks, and trends.",
  "runtime": {
    "command": "python main.py"
  },
  "required_secrets": [
    "ORCHAGENT_API_KEY",
    "DISCORD_WEBHOOK_URL",
    "ANTHROPIC_API_KEY",
    "GITHUB_REPOS"
  ],
  "bundle": {
    "include": ["*.py", "prompts/*.md", "requirements.txt"],
    "exclude": ["tests/", "__pycache__", "*.pyc", ".pytest_cache", ".env"]
  }
}
`

// ─── main.py ─────────────────────────────────────────────────────────────────

export const TEMPLATE_MAIN_PY = `"""GitHub Weekly Summary Agent -- main entrypoint.

A scheduled on-demand agent that:
1. Fetches GitHub activity (commits, PRs, issues, reviews) via the orchagent proxy
2. Analyses the data with Claude to produce an intelligent summary
3. Posts the summary to Discord via webhook
4. Exits

Triggered weekly by orchagent cron scheduling. Runs in an E2B sandbox.
"""

import asyncio
import json
import logging
import sys

import httpx

from config import Config
from github_fetcher import GitHubFetcher
from activity_store import ActivityStore
from analyst import Analyst

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("agent.main")

MAX_DISCORD_LENGTH = 1900


async def post_to_discord(webhook_url: str, content: str):
    """Post a message to Discord via webhook. Splits if over limit."""
    chunks = _split_message(content)

    async with httpx.AsyncClient(timeout=30.0) as client:
        for chunk in chunks:
            payload = {"content": chunk}
            response = await client.post(webhook_url, json=payload)
            if response.status_code >= 400:
                logger.error(
                    "Discord webhook failed (%d): %s",
                    response.status_code,
                    response.text[:200],
                )
                raise RuntimeError("Discord webhook returned %d" % response.status_code)
            logger.info("Posted chunk (%d chars) to Discord", len(chunk))


def _split_message(text: str) -> list[str]:
    """Split a message into chunks that fit within Discord's limit."""
    if len(text) <= MAX_DISCORD_LENGTH:
        return [text]

    chunks = []
    remaining = text
    while remaining:
        if len(remaining) <= MAX_DISCORD_LENGTH:
            chunks.append(remaining)
            break

        # Try paragraph boundary, then newline, then space, then hard split
        split_at = remaining.rfind("\\n\\n", 0, MAX_DISCORD_LENGTH)
        if split_at == -1:
            split_at = remaining.rfind("\\n", 0, MAX_DISCORD_LENGTH)
        if split_at == -1:
            split_at = remaining.rfind(" ", 0, MAX_DISCORD_LENGTH)
        if split_at == -1:
            split_at = MAX_DISCORD_LENGTH

        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip()

    return [c for c in chunks if c.strip()]


async def run():
    """Main execution: fetch activity, analyse, post summary."""
    logger.info("Starting GitHub Weekly Summary Agent")

    # Load config
    config = Config()
    logger.info("Config: %d repos, team=%s, model=%s", len(config.github_repos), config.team_name, config.model)

    # Fetch GitHub activity
    fetcher = GitHubFetcher(
        gateway_url=config.orchagent_gateway_url,
        api_key=config.orchagent_api_key,
    )
    store = ActivityStore(fetcher=fetcher, repos=config.github_repos)
    await store.refresh(days=14)

    if not store.window or (
        not store.window.commits
        and not store.window.pull_requests
        and not store.window.issues
    ):
        logger.warning("No activity found in the last 14 days. Posting minimal summary.")
        summary = "No GitHub activity detected in the last 14 days across %s." % ", ".join(config.github_repos)
    else:
        # Generate intelligent summary
        analyst = Analyst(
            api_key=config.anthropic_api_key,
            model=config.model,
            team_name=config.team_name,
        )
        summary = await analyst.generate_weekly_summary(store)

    # Post to Discord
    from datetime import datetime, timezone

    header = "**Weekly Development Summary -- %s**\\n\\n" % datetime.now(timezone.utc).strftime("%d %b %Y")
    await post_to_discord(config.discord_webhook_url, header + summary)

    logger.info("Done. Summary posted to Discord.")

    # Output for orchagent run history
    result = {
        "status": "success",
        "repos": config.github_repos,
        "commits": len(store.window.commits) if store.window else 0,
        "pull_requests": len(store.window.pull_requests) if store.window else 0,
        "issues": len(store.window.issues) if store.window else 0,
        "summary_length": len(summary),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(run())
`

// ─── config.py ───────────────────────────────────────────────────────────────

export const TEMPLATE_CONFIG_PY = `"""Configuration -- loads and validates all env vars on startup."""

import os
import sys


class Config:
    """Agent configuration loaded from environment variables."""

    def __init__(self):
        # Secrets (required)
        self.orchagent_api_key = _require("ORCHAGENT_API_KEY")
        self.discord_webhook_url = _require("DISCORD_WEBHOOK_URL")
        self.anthropic_api_key = _require("ANTHROPIC_API_KEY")

        # orchagent gateway URL (default to production)
        self.orchagent_gateway_url = os.getenv(
            "ORCHAGENT_GATEWAY_URL", "https://api.orchagent.io"
        )

        # GitHub repos to track (required)
        repos_raw = _require("GITHUB_REPOS")
        self.github_repos = [r.strip() for r in repos_raw.split(",") if r.strip()]

        # Team name (optional, used in prompts)
        self.team_name = os.getenv("TEAM_NAME", "Team")

        # LLM model
        self.model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5-20250929")


def _require(name: str) -> str:
    """Get a required env var or exit with a clear error."""
    value = os.getenv(name)
    if not value:
        print(
            "FATAL: Required environment variable %s is not set." % name,
            file=sys.stderr,
        )
        sys.exit(1)
    return value
`

// ─── github_fetcher.py ───────────────────────────────────────────────────────

export const TEMPLATE_GITHUB_FETCHER_PY = `"""Fetch GitHub activity via the orchagent GitHub Activity Proxy."""

import logging
from datetime import datetime, timezone, timedelta

import httpx

from models import Commit, PullRequest, Issue, ActivityWindow

logger = logging.getLogger("agent.github_fetcher")


class GitHubFetcher:
    """Fetches GitHub activity through the orchagent gateway proxy."""

    def __init__(self, gateway_url: str, api_key: str):
        self.base_url = f"{gateway_url.rstrip('/')}/github/activity"
        self.headers = {"Authorization": f"Bearer {api_key}"}

    async def fetch_all_activity(
        self, repos: list[str], days: int = 14
    ) -> ActivityWindow:
        """Fetch commits, PRs, and issues for all repos within the time window."""
        since = datetime.now(timezone.utc) - timedelta(days=days)
        since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")

        all_commits = []
        all_prs = []
        all_issues = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            for repo in repos:
                owner, name = repo.split("/", 1)

                commits = await self._fetch_commits(client, owner, name, since_iso)
                all_commits.extend(commits)

                prs = await self._fetch_pulls(client, owner, name)
                # Filter PRs updated since the window
                prs = [p for p in prs if p.updated_at >= since_iso]
                # Fetch reviews for each PR
                for pr in prs:
                    pr.reviews = await self._fetch_reviews(client, owner, name, pr.number)
                all_prs.extend(prs)

                issues = await self._fetch_issues(client, owner, name, since_iso)
                all_issues.extend(issues)

        now = datetime.now(timezone.utc)
        return ActivityWindow(
            repos=repos,
            commits=all_commits,
            pull_requests=all_prs,
            issues=all_issues,
            fetched_at=now,
            period_start=since,
            period_end=now,
        )

    async def _fetch_commits(
        self, client: httpx.AsyncClient, owner: str, repo: str, since: str
    ) -> list[Commit]:
        """Fetch commits from the proxy."""
        data = await self._get(
            client, f"/repos/{owner}/{repo}/commits", {"since": since, "per_page": 100}
        )
        if not isinstance(data, list):
            return []

        commits = []
        for item in data:
            commit_data = item.get("commit", {})
            author = item.get("author") or {}
            commit_author = commit_data.get("author", {})
            commits.append(
                Commit(
                    sha=item.get("sha", "")[:8],
                    author_login=author.get("login", commit_author.get("name", "unknown")),
                    author_name=commit_author.get("name", "unknown"),
                    message=commit_data.get("message", "").split("\\n")[0],  # First line only
                    date=commit_author.get("date", ""),
                    repo=f"{owner}/{repo}",
                )
            )
        return commits

    async def _fetch_pulls(
        self, client: httpx.AsyncClient, owner: str, repo: str
    ) -> list[PullRequest]:
        """Fetch pull requests from the proxy."""
        data = await self._get(
            client,
            f"/repos/{owner}/{repo}/pulls",
            {"state": "all", "sort": "updated", "direction": "desc", "per_page": 100},
        )
        if not isinstance(data, list):
            return []

        prs = []
        for item in data:
            user = item.get("user", {})
            # Determine if merged
            state = item.get("state", "open")
            if state == "closed" and item.get("merged_at"):
                state = "merged"

            prs.append(
                PullRequest(
                    number=item.get("number", 0),
                    title=item.get("title", ""),
                    author_login=user.get("login", "unknown"),
                    state=state,
                    created_at=item.get("created_at", ""),
                    updated_at=item.get("updated_at", ""),
                    merged_at=item.get("merged_at"),
                    closed_at=item.get("closed_at"),
                    comments_count=item.get("comments", 0),
                    review_comments_count=item.get("review_comments", 0),
                    additions=item.get("additions", 0),
                    deletions=item.get("deletions", 0),
                    repo=f"{owner}/{repo}",
                )
            )
        return prs

    async def _fetch_issues(
        self, client: httpx.AsyncClient, owner: str, repo: str, since: str
    ) -> list[Issue]:
        """Fetch issues (not PRs) from the proxy."""
        data = await self._get(
            client,
            f"/repos/{owner}/{repo}/issues",
            {"state": "all", "sort": "updated", "direction": "desc", "since": since, "per_page": 100},
        )
        if not isinstance(data, list):
            return []

        issues = []
        for item in data:
            # GitHub issues endpoint also returns PRs -- skip them
            if "pull_request" in item:
                continue

            user = item.get("user", {})
            labels = [l.get("name", "") for l in item.get("labels", [])]
            issues.append(
                Issue(
                    number=item.get("number", 0),
                    title=item.get("title", ""),
                    author_login=user.get("login", "unknown"),
                    state=item.get("state", "open"),
                    created_at=item.get("created_at", ""),
                    updated_at=item.get("updated_at", ""),
                    closed_at=item.get("closed_at"),
                    comments_count=item.get("comments", 0),
                    labels=labels,
                    repo=f"{owner}/{repo}",
                )
            )
        return issues

    async def _fetch_reviews(
        self, client: httpx.AsyncClient, owner: str, repo: str, pull_number: int
    ) -> list[dict]:
        """Fetch reviews for a specific PR."""
        data = await self._get(
            client, f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews", {"per_page": 100}
        )
        if not isinstance(data, list):
            return []

        return [
            {
                "reviewer": item.get("user", {}).get("login", "unknown"),
                "state": item.get("state", ""),
                "submitted_at": item.get("submitted_at", ""),
            }
            for item in data
        ]

    async def _get(self, client: httpx.AsyncClient, path: str, params: dict) -> list | dict:
        """Make a GET request to the proxy with retry on 429."""
        url = f"{self.base_url}{path}"
        try:
            response = await client.get(url, headers=self.headers, params=params)

            if response.status_code == 429:
                logger.warning("Rate limited by proxy, waiting 60s before retry")
                import asyncio
                await asyncio.sleep(60)
                response = await client.get(url, headers=self.headers, params=params)

            if response.status_code >= 400:
                logger.error("Proxy returned %d for %s: %s", response.status_code, path, response.text[:200])
                return []

            return response.json()
        except httpx.TimeoutException:
            logger.error("Timeout fetching %s", path)
            return []
        except Exception as e:
            logger.error("Error fetching %s: %s", path, str(e))
            return []
`

// ─── activity_store.py ───────────────────────────────────────────────────────

export const TEMPLATE_ACTIVITY_STORE_PY = `"""Rolling activity window with stats computation and LLM serialisation."""

import logging
from datetime import datetime, timezone, timedelta
from collections import defaultdict

from models import ActivityWindow, Commit, PullRequest, Issue
from github_fetcher import GitHubFetcher

logger = logging.getLogger("agent.activity_store")


class ActivityStore:
    """Maintains a rolling window of GitHub activity."""

    def __init__(self, fetcher: GitHubFetcher, repos: list[str]):
        self.fetcher = fetcher
        self.repos = repos
        self.window: ActivityWindow | None = None

    def is_stale(self, max_age_minutes: int = 60) -> bool:
        """Check if the activity data needs refreshing."""
        if self.window is None or self.window.fetched_at is None:
            return True
        age = datetime.now(timezone.utc) - self.window.fetched_at
        return age > timedelta(minutes=max_age_minutes)

    async def refresh(self, days: int = 14) -> ActivityWindow:
        """Fetch fresh activity data from GitHub."""
        logger.info("Refreshing activity data for %d repos (%d day window)", len(self.repos), days)
        self.window = await self.fetcher.fetch_all_activity(self.repos, days=days)
        logger.info(
            "Fetched: %d commits, %d PRs, %d issues",
            len(self.window.commits),
            len(self.window.pull_requests),
            len(self.window.issues),
        )
        return self.window

    async def ensure_fresh(self, max_age_minutes: int = 60) -> ActivityWindow:
        """Refresh if stale, return current window."""
        if self.is_stale(max_age_minutes):
            await self.refresh()
        return self.window

    def compute_stats(self) -> dict:
        """Compute summary statistics from the current window."""
        if not self.window:
            return {}

        now = datetime.now(timezone.utc)
        week_ago = now - timedelta(days=7)
        two_weeks_ago = now - timedelta(days=14)

        # Commits per author
        commits_by_author = defaultdict(int)
        commits_this_week = 0
        commits_last_week = 0
        for c in self.window.commits:
            commits_by_author[c.author_login] += 1
            if c.date >= week_ago.strftime("%Y-%m-%dT%H:%M:%SZ"):
                commits_this_week += 1
            elif c.date >= two_weeks_ago.strftime("%Y-%m-%dT%H:%M:%SZ"):
                commits_last_week += 1

        # PR stats
        prs_opened = [p for p in self.window.pull_requests if p.created_at >= week_ago.strftime("%Y-%m-%dT%H:%M:%SZ")]
        prs_merged = [p for p in self.window.pull_requests if p.state == "merged" and p.merged_at and p.merged_at >= week_ago.strftime("%Y-%m-%dT%H:%M:%SZ")]
        prs_open = [p for p in self.window.pull_requests if p.state == "open"]

        # Stale PRs (open > 5 days with no update)
        stale_threshold = (now - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_prs = [p for p in prs_open if p.updated_at < stale_threshold]

        # Review turnaround (time from PR creation to first review)
        review_turnarounds = []
        for pr in self.window.pull_requests:
            if pr.reviews:
                first_review = min(pr.reviews, key=lambda r: r.get("submitted_at", ""))
                submitted = first_review.get("submitted_at", "")
                if submitted and pr.created_at:
                    try:
                        created = datetime.fromisoformat(pr.created_at.replace("Z", "+00:00"))
                        reviewed = datetime.fromisoformat(submitted.replace("Z", "+00:00"))
                        hours = (reviewed - created).total_seconds() / 3600
                        review_turnarounds.append(hours)
                    except (ValueError, TypeError):
                        pass

        avg_review_turnaround = (
            sum(review_turnarounds) / len(review_turnarounds)
            if review_turnarounds
            else None
        )

        # Issues
        issues_opened = [i for i in self.window.issues if i.created_at >= week_ago.strftime("%Y-%m-%dT%H:%M:%SZ")]
        issues_closed = [i for i in self.window.issues if i.state == "closed" and i.closed_at and i.closed_at >= week_ago.strftime("%Y-%m-%dT%H:%M:%SZ")]

        return {
            "period": "last 7 days",
            "commits_total": len(self.window.commits),
            "commits_this_week": commits_this_week,
            "commits_last_week": commits_last_week,
            "commits_by_author": dict(commits_by_author),
            "prs_opened_this_week": len(prs_opened),
            "prs_merged_this_week": len(prs_merged),
            "prs_currently_open": len(prs_open),
            "stale_prs": [{"number": p.number, "title": p.title, "repo": p.repo, "author": p.author_login, "days_since_update": (now - datetime.fromisoformat(p.updated_at.replace("Z", "+00:00"))).days} for p in stale_prs],
            "avg_review_turnaround_hours": round(avg_review_turnaround, 1) if avg_review_turnaround else None,
            "issues_opened_this_week": len(issues_opened),
            "issues_closed_this_week": len(issues_closed),
        }

    def serialise_for_llm(self) -> str:
        """Serialise the activity window into a structured text block for LLM context."""
        if not self.window:
            return "No activity data available."

        stats = self.compute_stats()
        lines = []

        lines.append(f"## GitHub Activity -- {stats['period']}")
        lines.append(f"Repos: {', '.join(self.window.repos)}")
        lines.append("")

        # Commit summary
        lines.append(f"### Commits: {stats['commits_this_week']} this week, {stats['commits_last_week']} last week")
        if stats["commits_by_author"]:
            for author, count in sorted(stats["commits_by_author"].items(), key=lambda x: -x[1]):
                lines.append(f"  - {author}: {count} commits")
        lines.append("")

        # Recent commit messages
        lines.append("### Recent Commits (last 7 days)")
        week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        recent_commits = [c for c in self.window.commits if c.date >= week_ago][:20]
        for c in recent_commits:
            lines.append(f"  - [{c.repo}] {c.author_login}: {c.message}")
        if not recent_commits:
            lines.append("  (none)")
        lines.append("")

        # PR summary
        lines.append(f"### Pull Requests: {stats['prs_opened_this_week']} opened, {stats['prs_merged_this_week']} merged, {stats['prs_currently_open']} currently open")
        if stats["avg_review_turnaround_hours"] is not None:
            lines.append(f"  Average review turnaround: {stats['avg_review_turnaround_hours']}h")
        lines.append("")

        # Open PRs
        open_prs = [p for p in self.window.pull_requests if p.state == "open"]
        if open_prs:
            lines.append("### Open Pull Requests")
            for p in open_prs:
                review_status = "no reviews"
                if p.reviews:
                    states = [r["state"] for r in p.reviews]
                    if "APPROVED" in states:
                        review_status = "approved"
                    elif "CHANGES_REQUESTED" in states:
                        review_status = "changes requested"
                    else:
                        review_status = f"{len(p.reviews)} review(s)"
                lines.append(f"  - #{p.number} [{p.repo}] \\"{p.title}\\" by {p.author_login} ({review_status})")
            lines.append("")

        # Merged PRs
        merged_prs = [p for p in self.window.pull_requests if p.state == "merged"]
        if merged_prs:
            lines.append("### Recently Merged")
            for p in merged_prs[:10]:
                lines.append(f"  - #{p.number} [{p.repo}] \\"{p.title}\\" by {p.author_login}")
            lines.append("")

        # Stale PRs
        if stats["stale_prs"]:
            lines.append("### Stale PRs (open > 5 days, no recent activity)")
            for sp in stats["stale_prs"]:
                lines.append(f"  - #{sp['number']} [{sp['repo']}] \\"{sp['title']}\\" by {sp['author']} ({sp['days_since_update']} days idle)")
            lines.append("")

        # Issues
        lines.append(f"### Issues: {stats['issues_opened_this_week']} opened, {stats['issues_closed_this_week']} closed this week")
        open_issues = [i for i in self.window.issues if i.state == "open"]
        if open_issues:
            for i in open_issues[:10]:
                label_str = f" [{', '.join(i.labels)}]" if i.labels else ""
                lines.append(f"  - #{i.number} [{i.repo}] \\"{i.title}\\"{label_str}")
        lines.append("")

        return "\\n".join(lines)
`

// ─── analyst.py ──────────────────────────────────────────────────────────────

export const TEMPLATE_ANALYST_PY = `"""LLM analyst -- generates intelligent weekly summaries."""

import logging
import os

import anthropic

from activity_store import ActivityStore

logger = logging.getLogger("agent.analyst")


class Analyst:
    """Uses Claude to reason about GitHub activity."""

    def __init__(self, api_key: str, model: str, team_name: str):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.team_name = team_name
        self._summary_prompt = _load_prompt("prompts/weekly_summary.md")

    async def generate_weekly_summary(self, store: ActivityStore) -> str:
        """Generate an intelligent weekly summary from the activity window."""
        from datetime import datetime, timezone

        activity_data = store.serialise_for_llm()
        repos = ", ".join(store.repos)
        now = datetime.now(timezone.utc)
        current_date = now.strftime("%d %b %Y")

        # Period range from activity window
        period_start = store.window.period_start.strftime("%d %b %Y") if store.window and store.window.period_start else "unknown"
        period_end = store.window.period_end.strftime("%d %b %Y") if store.window and store.window.period_end else current_date

        system_prompt = self._summary_prompt.replace(
            "{team_name}", self.team_name
        ).replace(
            "{repos}", repos
        ).replace(
            "{current_date}", current_date
        ).replace(
            "{period_start}", period_start
        ).replace(
            "{period_end}", period_end
        ).replace(
            "{activity_data}", activity_data
        )

        logger.info("Generating weekly summary (%d chars of activity data)", len(activity_data))

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1500,
            messages=[
                {"role": "user", "content": "Write the weekly development summary."}
            ],
            system=system_prompt,
        )

        summary = response.content[0].text
        logger.info(
            "Summary generated: %d chars, %d input tokens, %d output tokens",
            len(summary),
            response.usage.input_tokens,
            response.usage.output_tokens,
        )
        return summary


def _load_prompt(path: str) -> str:
    """Load a prompt template from file."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    full_path = os.path.join(base_dir, path)
    with open(full_path, "r") as f:
        return f.read()
`

// ─── models.py ───────────────────────────────────────────────────────────────

export const TEMPLATE_MODELS_PY = `"""Data models for normalised GitHub activity."""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Commit:
    sha: str
    author_login: str
    author_name: str
    message: str
    date: str
    repo: str


@dataclass
class PullRequest:
    number: int
    title: str
    author_login: str
    state: str  # open, closed, merged
    created_at: str
    updated_at: str
    merged_at: str | None
    closed_at: str | None
    comments_count: int
    review_comments_count: int
    additions: int
    deletions: int
    repo: str
    reviews: list[dict] = field(default_factory=list)


@dataclass
class Issue:
    number: int
    title: str
    author_login: str
    state: str  # open, closed
    created_at: str
    updated_at: str
    closed_at: str | None
    comments_count: int
    labels: list[str]
    repo: str


@dataclass
class ActivityWindow:
    repos: list[str]
    commits: list[Commit]
    pull_requests: list[PullRequest]
    issues: list[Issue]
    fetched_at: datetime | None = None
    period_start: datetime | None = None
    period_end: datetime | None = None
`

// ─── requirements.txt ────────────────────────────────────────────────────────

export const TEMPLATE_REQUIREMENTS_TXT = `httpx>=0.27.0
anthropic>=0.40.0
`

// ─── prompts/weekly_summary.md ───────────────────────────────────────────────

export const TEMPLATE_WEEKLY_SUMMARY_PROMPT = `You are a senior engineering manager analysing your team's GitHub activity for the past week. Your job is to write a concise, insightful weekly summary that a CTO or team lead would actually want to read on Monday morning.

**Current date: {current_date}**
**Reporting period: {period_start} to {period_end}**

Rules:
- INTERPRET, don't just list. "3 PRs merged" is useless. "The auth refactor shipped -- 3 PRs merged across 2 repos" is useful.
- Highlight what SHIPPED (merged PRs, significant commits). This is the headline.
- Flag RISKS: stale PRs, unreviewed changes, unusual patterns (e.g. someone suddenly only doing docs, or a single person doing all reviews).
- Note TRENDS if visible: is velocity up or down vs last week? Is review turnaround getting slower?
- Keep it to 3-4 short paragraphs. No bullet dumps. Write like a human, not a report generator.
- If there's not much activity, say so honestly. Don't inflate.
- Use PR numbers (#42) and author names when citing specifics.
- End with 1-2 things to watch this week (stale PRs, upcoming deadlines implied by activity patterns).

Team: {team_name}
Repos: {repos}

{activity_data}
`

// ─── .env.example ────────────────────────────────────────────────────────────

export const TEMPLATE_ENV_EXAMPLE = `# Required secrets -- add these via: orch secrets set NAME VALUE
# Or in the web dashboard: Settings > Secrets

# orchagent API key -- create after publishing:
#   orch agent-keys create <your-org>/{{name}}
ORCHAGENT_API_KEY=

# Discord webhook URL -- create at: Server Settings > Integrations > Webhooks > New Webhook
DISCORD_WEBHOOK_URL=

# Anthropic API key -- get from: https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=

# Comma-separated GitHub repos to track (owner/repo format)
# The GitHub owner must match the account connected via: orch github connect
GITHUB_REPOS=myorg/my-repo

# Optional settings
TEAM_NAME=My Team
CLAUDE_MODEL=claude-sonnet-4-5-20250929
`

// ─── README.md ───────────────────────────────────────────────────────────────

export const TEMPLATE_README = `# {{name}}

A scheduled AI agent that analyses your team's GitHub activity and delivers intelligent weekly summaries to Discord.

**What it does:** Every week (on your schedule), this agent fetches commits, PRs, and issues from your GitHub repos, uses Claude to identify patterns, risks, and trends, then posts an insightful summary to your Discord channel. Not a formatted list -- real analysis.

## Quick Start (5 minutes)

### 1. Connect GitHub

\`\`\`bash
orch github connect
\`\`\`

Grant access to the repos you want to track. The agent uses orchagent's GitHub proxy -- no personal access tokens needed.

### 2. Publish

\`\`\`bash
orch publish
\`\`\`

### 3. Add secrets

Add these in the orchagent web dashboard (**Settings > Secrets**), or via CLI:

\`\`\`bash
orch secrets set ORCHAGENT_API_KEY <key>       # Run: orch agent-keys create <your-org>/{{name}}
orch secrets set DISCORD_WEBHOOK_URL <url>     # Discord > Server Settings > Integrations > Webhooks
orch secrets set ANTHROPIC_API_KEY <key>       # https://console.anthropic.com/settings/keys
orch secrets set GITHUB_REPOS owner/repo       # Comma-separated: owner/repo1,owner/repo2
\`\`\`

Optional:
\`\`\`bash
orch secrets set TEAM_NAME "My Team"
orch secrets set CLAUDE_MODEL claude-sonnet-4-5-20250929
\`\`\`

### 4. Test run

\`\`\`bash
orch run <your-org>/{{name}}
\`\`\`

Check your Discord channel -- the summary should appear within ~30 seconds.

### 5. Schedule

\`\`\`bash
orch schedule create <your-org>/{{name}} --cron "0 9 * * 1" --timezone "Europe/London"
\`\`\`

This runs every Monday at 9am. Adjust the cron and timezone:
- \`0 9 * * 1\` -- Monday 9am
- \`0 9 * * 1-5\` -- Every weekday 9am
- \`0 17 * * 5\` -- Friday 5pm

### Done!

View runs and logs:

\`\`\`bash
orch logs                            # Recent runs
orch schedule list                   # Your schedules
orch schedule trigger <schedule-id>  # Manual trigger
\`\`\`

## How It Works

\`\`\`
main.py (runs once per trigger, then exits)
  |-- GitHub fetcher -> orchagent GitHub Activity Proxy
  |   \`-- Commits, PRs, issues, reviews (14-day window)
  |-- Activity store -> Stats computation
  |   \`-- Commits/author, PR turnaround, stale PRs, trends
  |-- Analyst -> Claude LLM call
  |   \`-- Intelligent narrative summary (not a list)
  \`-- Discord webhook POST
      \`-- Summary delivered to your channel
\`\`\`

The agent analyses 14 days of data (not just 7) so it can detect week-over-week trends.

## Customisation

### Prompt tuning
Edit \`prompts/weekly_summary.md\` to change what the summary focuses on. The prompt controls the entire character of the output.

### Multiple repos
Set \`GITHUB_REPOS\` to a comma-separated list: \`org/repo1,org/repo2,org/repo3\`

### Multiple channels
To post to different Discord channels, deploy multiple instances with different \`DISCORD_WEBHOOK_URL\` secrets (use separate workspaces).

## Cost

~$0.01 per run (Claude Sonnet API call + E2B sandbox). At weekly frequency: ~$0.05/month.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "MISSING_SECRETS" error | Add all required secrets in Settings > Secrets |
| "GitHub App not installed" | Run \`orch github connect\` and grant repo access |
| Empty summary | Check \`GITHUB_REPOS\` format -- must be \`owner/repo\`, not just \`repo\` |
| Discord webhook 400/404 | Regenerate webhook in Discord server settings |
| No runs appearing | Check \`orch logs\` and \`orch schedule list\` |
`

// ─── Available templates registry ────────────────────────────────────────────

export const AVAILABLE_TEMPLATES = ['github-weekly-summary'] as const
export type TemplateName = (typeof AVAILABLE_TEMPLATES)[number]
