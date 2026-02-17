/**
 * Multi-Platform Support Agent template.
 *
 * Generates a three-tier support agent that connects to Discord, Telegram,
 * and/or Slack based on which tokens are configured.
 */

export const SA_CONFIG_PY = `"""
Support Agent Configuration — Edit these 4 fields to customize your agent.
"""

# The name your bot uses when responding
BOT_NAME = "Support Agent"

# Your product/service name — used in prompts and classification
PRODUCT_NAME = "My Product"

# One-sentence description — helps the classifier understand your domain
PRODUCT_DESCRIPTION = "a platform for doing amazing things"

# Knowledge files used for the FAQ tier (general questions).
FAQ_FILES = ["00-overview.md", "99-faq.md"]
`

export const SA_BRAIN_PY = `"""
Support Agent Brain — Three-Tier Architecture

Tier 1: CLASSIFY  — Haiku classifier decides if/how to respond
Tier 2: FAQ       — General knowledge handles ~80% of questions (cached)
Tier 3: DEEP DOCS — Topic-specific docs for detailed questions (cached per topic)
"""

import json
import logging
import os
import sys
from pathlib import Path

import anthropic

from config import BOT_NAME, FAQ_FILES, PRODUCT_DESCRIPTION, PRODUCT_NAME

logger = logging.getLogger("support-agent.brain")

CLASSIFY_MODEL = os.environ.get("CLASSIFY_MODEL", "claude-haiku-4-5-20251001")
RESPOND_MODEL = os.environ.get("RESPOND_MODEL", "claude-sonnet-4-5-20250929")
CLASSIFY_MAX_TOKENS = 150
RESPOND_MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "1024"))

DOCS_DIR = Path(__file__).parent / "knowledge"


def load_doc_files() -> dict[str, str]:
    docs: dict[str, str] = {}
    if not DOCS_DIR.is_dir():
        logger.warning("knowledge/ directory not found")
        return docs
    for md_file in sorted(DOCS_DIR.glob("*.md")):
        content = md_file.read_text(encoding="utf-8").strip()
        if content:
            docs[md_file.name] = content
    logger.info("Loaded %d knowledge files", len(docs))
    return docs


def discover_topics(doc_files: dict[str, str]) -> dict[str, list[str]]:
    topics: dict[str, list[str]] = {}
    faq_set = set(FAQ_FILES)
    for filename in sorted(doc_files.keys()):
        if filename in faq_set:
            continue
        stem = filename.rsplit(".", 1)[0]
        parts = stem.split("-", 1)
        if len(parts) == 2 and parts[0].isdigit():
            topic = parts[1]
        else:
            topic = stem
        topic = topic.strip().lower().replace(" ", "-").replace("_", "-")
        if not topic:
            continue
        topics.setdefault(topic, []).append(filename)
    return topics


def build_docs_context(doc_files: dict[str, str], filenames: list[str]) -> str:
    parts: list[str] = []
    for name in filenames:
        if name in doc_files:
            title = name.rsplit(".", 1)[0].replace("-", " ").title()
            parts.append(f"## {title}\\n\\n{doc_files[name]}")
    return "\\n\\n---\\n\\n".join(parts)


def get_deep_files(topics: list[str], topic_files: dict[str, list[str]]) -> list[str]:
    files: list[str] = []
    seen: set[str] = set()
    for topic in topics:
        for f in topic_files.get(topic, []):
            if f not in seen:
                files.append(f)
                seen.add(f)
    for f in FAQ_FILES:
        if f not in seen:
            files.append(f)
            seen.add(f)
    return files


def build_response_rules() -> str:
    return f"""\\
You are {BOT_NAME}, the official support assistant for {PRODUCT_NAME}.

Your job is to answer user questions about {PRODUCT_NAME} accurately and helpfully, grounded in the documentation provided below. Follow these rules:

1. Base your answers ONLY on the documentation below. Do not guess or make up features.
2. Be concise and direct. Messages should be readable, not walls of text.
3. Use code blocks for commands and code examples.
4. If the documentation doesn't cover the question, say: "I'm not sure about this — a human will follow up." Do NOT hallucinate an answer.
5. If a question is ambiguous, ask for clarification before answering.
6. Be friendly and professional. You represent the {PRODUCT_NAME} team.
7. Do not discuss pricing specifics beyond what's in the docs.
8. Do not share internal implementation details, architecture decisions, or roadmap items.
9. Keep responses under 1800 characters to stay readable.

---

# {PRODUCT_NAME} Documentation

"""


def build_classify_system_prompt(topic_list: list[str]) -> str:
    topic_csv = ", ".join(topic_list) if topic_list else "general"
    return f"""\\
You are a message classifier for the {PRODUCT_NAME} support channel.
{PRODUCT_NAME} is {PRODUCT_DESCRIPTION}.

Classify the user's message. Return ONLY valid JSON, no other text.

Topics: {topic_csv}

{{"respond": bool, "tier": "faq" or "deep", "topics": ["topic1"]}}

Rules:
- "respond": false for greetings, thanks, off-topic chat, non-questions, emoji, memes
- "tier": "faq" for simple/general questions about the platform
- "tier": "deep" for questions needing specific technical details
- "topics": 1-2 relevant topics when tier is "deep", empty list for "faq" """


def build_faq_prompt(doc_files: dict[str, str]) -> str:
    return build_response_rules() + build_docs_context(doc_files, FAQ_FILES)


def build_deep_prompt(doc_files: dict[str, str], topics: list[str], topic_files: dict[str, list[str]]) -> str:
    files = get_deep_files(topics, topic_files)
    return build_response_rules() + build_docs_context(doc_files, files)


def create_anthropic_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        logger.error("ANTHROPIC_API_KEY not set")
        sys.exit(1)
    return anthropic.Anthropic(api_key=api_key)


def classify_message(client: anthropic.Anthropic, user_message: str, system_prompt: str) -> dict:
    try:
        response = client.messages.create(
            model=CLASSIFY_MODEL, max_tokens=CLASSIFY_MAX_TOKENS,
            system=system_prompt, messages=[{"role": "user", "content": user_message}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("\\\`\\\`\\\`"):
            raw = raw.split("\\n", 1)[1].rsplit("\\\`\\\`\\\`", 1)[0].strip()
        result = json.loads(raw)
        logger.info("Classify: respond=%s tier=%s topics=%s (in=%d out=%d)",
            result.get("respond"), result.get("tier"), result.get("topics"),
            response.usage.input_tokens, response.usage.output_tokens)
        return result
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        logger.warning("Classifier returned invalid JSON: %s", exc)
        return {"respond": True, "tier": "faq", "topics": []}
    except anthropic.APIError as exc:
        logger.warning("Classifier API error: %s", exc)
        return {"respond": True, "tier": "faq", "topics": []}


def query_llm(client: anthropic.Anthropic, system_prompt: str, user_message: str) -> tuple[str, int, int]:
    response = client.messages.create(
        model=RESPOND_MODEL, max_tokens=RESPOND_MAX_TOKENS,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_message}],
    )
    return response.content[0].text, response.usage.input_tokens, response.usage.output_tokens


class Brain:
    def __init__(self, anthropic_client, doc_files, topic_files, faq_prompt, classify_system_prompt):
        self.client = anthropic_client
        self.doc_files = doc_files
        self.topic_files = topic_files
        self.faq_prompt = faq_prompt
        self.classify_system_prompt = classify_system_prompt

    def classify(self, message: str) -> dict:
        return classify_message(self.client, message, self.classify_system_prompt)

    def respond_faq(self, message: str) -> tuple[str, int, int]:
        return query_llm(self.client, self.faq_prompt, message)

    def respond_deep(self, message: str, topics: list[str]) -> tuple[str, int, int]:
        prompt = build_deep_prompt(self.doc_files, topics, self.topic_files)
        return query_llm(self.client, prompt, message)
`

export const SA_DISCORD_CONNECTOR_PY = `"""Discord connector for the support agent."""

import asyncio
import logging
import os
import time

import anthropic
import discord

from brain import Brain

logger = logging.getLogger("support-agent.discord")
USER_COOLDOWN_SECONDS = int(os.environ.get("USER_COOLDOWN_SECONDS", "5"))


def parse_channel_ids(raw: str) -> set[int]:
    ids: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids


def should_respond(message: discord.Message, allowed_channels: set[int]) -> bool:
    if message.author.bot:
        return False
    channel_id = message.channel.id
    parent_id = getattr(message.channel, "parent_id", None)
    if channel_id not in allowed_channels and parent_id not in allowed_channels:
        return False
    if not message.content or not message.content.strip():
        return False
    if len(message.content.strip()) < 5:
        return False
    return True


class DiscordConnector(discord.Client):
    def __init__(self, brain: Brain, allowed_channels: set[int]):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(intents=intents)
        self.brain = brain
        self.allowed_channels = allowed_channels
        self._user_last_response: dict[int, float] = {}

    async def on_ready(self) -> None:
        logger.info("Discord connected as %s (id=%s)", self.user, self.user.id)

    async def on_message(self, message: discord.Message) -> None:
        if not should_respond(message, self.allowed_channels):
            return
        now = time.time()
        if now - self._user_last_response.get(message.author.id, 0) < USER_COOLDOWN_SECONDS:
            return
        user_text = message.content.strip()
        classification = await asyncio.to_thread(self.brain.classify, user_text)
        if not classification.get("respond", True):
            return
        tier = classification.get("tier", "faq")
        topics = classification.get("topics", [])
        try:
            thread = await message.create_thread(name="Q: " + user_text[:80], auto_archive_duration=60)
        except discord.HTTPException:
            thread = message.channel
        async with thread.typing():
            try:
                if tier == "deep" and topics:
                    answer, _, _ = await asyncio.to_thread(self.brain.respond_deep, user_text, topics)
                else:
                    answer, _, _ = await asyncio.to_thread(self.brain.respond_faq, user_text)
            except anthropic.RateLimitError:
                await thread.send("I'm getting a lot of questions right now. Please try again in a minute.")
                return
            except anthropic.APITimeoutError:
                await thread.send("My response timed out. Please try again.")
                return
            except anthropic.APIError:
                await thread.send("I ran into an issue generating a response. A human will follow up.")
                return
        if len(answer) > 1900:
            answer = answer[:1897] + "..."
        await thread.send(answer)
        self._user_last_response[message.author.id] = time.time()

    async def run_async(self, token: str) -> None:
        await self.start(token)
`

export const SA_TELEGRAM_CONNECTOR_PY = `"""Telegram connector for the support agent."""

import asyncio
import logging
import os
import time

from telegram import Update
from telegram.ext import Application, ContextTypes, MessageHandler, filters

from brain import Brain

logger = logging.getLogger("support-agent.telegram")
USER_COOLDOWN_SECONDS = int(os.environ.get("USER_COOLDOWN_SECONDS", "5"))


class TelegramConnector:
    def __init__(self, brain: Brain, token: str):
        self.brain = brain
        self.token = token
        self._user_last_response: dict[int, float] = {}

    async def _handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        message = update.message
        if not message or not message.text:
            return
        user_text = message.text.strip()
        if len(user_text) < 5:
            return
        user_id = message.from_user.id if message.from_user else 0
        now = time.time()
        if now - self._user_last_response.get(user_id, 0) < USER_COOLDOWN_SECONDS:
            return
        classification = await asyncio.to_thread(self.brain.classify, user_text)
        if not classification.get("respond", True):
            return
        tier = classification.get("tier", "faq")
        topics = classification.get("topics", [])
        await message.chat.send_action("typing")
        try:
            if tier == "deep" and topics:
                answer, _, _ = await asyncio.to_thread(self.brain.respond_deep, user_text, topics)
            else:
                answer, _, _ = await asyncio.to_thread(self.brain.respond_faq, user_text)
        except Exception:
            await message.reply_text("I ran into an issue generating a response. A human will follow up.")
            return
        if len(answer) > 4000:
            answer = answer[:3997] + "..."
        await message.reply_text(answer)
        self._user_last_response[user_id] = time.time()

    async def run(self) -> None:
        app = Application.builder().token(self.token).build()
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_message))
        await app.initialize()
        await app.start()
        await app.updater.start_polling(drop_pending_updates=True)
        try:
            await asyncio.Event().wait()
        finally:
            await app.updater.stop()
            await app.stop()
            await app.shutdown()
`

export const SA_SLACK_CONNECTOR_PY = `"""Slack connector for the support agent (Socket Mode)."""

import asyncio
import logging
import os
import time

from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler
from slack_bolt.async_app import AsyncApp

from brain import Brain

logger = logging.getLogger("support-agent.slack")
USER_COOLDOWN_SECONDS = int(os.environ.get("USER_COOLDOWN_SECONDS", "5"))


class SlackConnector:
    def __init__(self, brain: Brain, bot_token: str, app_token: str):
        self.brain = brain
        self.app = AsyncApp(token=bot_token)
        self.app_token = app_token
        self._user_last_response: dict[str, float] = {}
        self._register_handlers()

    def _register_handlers(self) -> None:
        @self.app.event("message")
        async def handle_message(event, say):
            if event.get("bot_id") or event.get("subtype"):
                return
            text = event.get("text", "").strip()
            if not text or len(text) < 5:
                return
            user_id = event.get("user", "unknown")
            now = time.time()
            if now - self._user_last_response.get(user_id, 0) < USER_COOLDOWN_SECONDS:
                return
            classification = await asyncio.to_thread(self.brain.classify, text)
            if not classification.get("respond", True):
                return
            tier = classification.get("tier", "faq")
            topics = classification.get("topics", [])
            try:
                if tier == "deep" and topics:
                    answer, _, _ = await asyncio.to_thread(self.brain.respond_deep, text, topics)
                else:
                    answer, _, _ = await asyncio.to_thread(self.brain.respond_faq, text)
            except Exception:
                await say("I ran into an issue generating a response. A human will follow up.")
                return
            if len(answer) > 3000:
                answer = answer[:2997] + "..."
            await say(answer, thread_ts=event.get("ts"))
            self._user_last_response[user_id] = time.time()

    async def run(self) -> None:
        handler = AsyncSocketModeHandler(self.app, self.app_token)
        await handler.start_async()
`

export const SA_MAIN_PY = `"""
Multi-Platform Support Agent — Startup Orchestrator

Checks which platform tokens are configured and starts those connectors.
"""

import asyncio
import logging
import os
import sys

from brain import (Brain, build_classify_system_prompt, build_faq_prompt,
                   create_anthropic_client, discover_topics, load_doc_files)
from config import FAQ_FILES

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
logger = logging.getLogger("support-agent")


def validate_knowledge(doc_files: dict[str, str]) -> None:
    if not doc_files:
        logger.error("No knowledge files found in knowledge/ directory")
        sys.exit(1)
    for faq_file in FAQ_FILES:
        if faq_file not in doc_files:
            logger.error("FAQ file '%s' not found in knowledge/", faq_file)
            sys.exit(1)


async def run_connectors(brain: Brain) -> None:
    tasks = []
    active = []

    discord_token = os.environ.get("DISCORD_BOT_TOKEN", "")
    if discord_token:
        from connectors.discord_connector import DiscordConnector, parse_channel_ids
        channels_raw = os.environ.get("DISCORD_CHANNEL_IDS", "")
        if not channels_raw:
            logger.error("DISCORD_BOT_TOKEN set but DISCORD_CHANNEL_IDS missing")
            sys.exit(1)
        channels = parse_channel_ids(channels_raw)
        if not channels:
            logger.error("No valid channel IDs in DISCORD_CHANNEL_IDS")
            sys.exit(1)
        tasks.append(DiscordConnector(brain, channels).run_async(discord_token))
        active.append("Discord")

    telegram_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if telegram_token:
        from connectors.telegram_connector import TelegramConnector
        tasks.append(TelegramConnector(brain, telegram_token).run())
        active.append("Telegram")

    slack_bot_token = os.environ.get("SLACK_BOT_TOKEN", "")
    if slack_bot_token:
        from connectors.slack_connector import SlackConnector
        slack_app_token = os.environ.get("SLACK_APP_TOKEN", "")
        if not slack_app_token:
            logger.error("SLACK_BOT_TOKEN set but SLACK_APP_TOKEN missing")
            sys.exit(1)
        tasks.append(SlackConnector(brain, slack_bot_token, slack_app_token).run())
        active.append("Slack")

    if not tasks:
        logger.error("No platform tokens configured. Set at least one of: DISCORD_BOT_TOKEN, TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN")
        sys.exit(1)

    logger.info("Active platforms: %s", ", ".join(active))
    await asyncio.gather(*tasks)


def main() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        logger.error("ANTHROPIC_API_KEY not set")
        sys.exit(1)

    doc_files = load_doc_files()
    validate_knowledge(doc_files)

    topic_files = discover_topics(doc_files)
    topic_list = sorted(topic_files.keys())
    faq_prompt = build_faq_prompt(doc_files)
    classify_prompt = build_classify_system_prompt(topic_list)

    logger.info("Topics discovered: %s", topic_list)

    brain = Brain(
        anthropic_client=create_anthropic_client(),
        doc_files=doc_files, topic_files=topic_files,
        faq_prompt=faq_prompt, classify_system_prompt=classify_prompt,
    )

    logger.info("Starting Multi-Platform Support Agent")
    asyncio.run(run_connectors(brain))


if __name__ == "__main__":
    main()
`

export const SA_REQUIREMENTS = `discord.py>=2.3.0,<3.0.0
python-telegram-bot>=21.0,<22.0.0
slack-bolt>=1.18.0,<2.0.0
anthropic>=0.40.0,<1.0.0
`

export const SA_OVERVIEW_MD = `# My Product Overview

Welcome to My Product! This is a placeholder overview document.

Replace this file with your own product overview and FAQ-tier knowledge.

## Getting Started

1. Sign up at myproduct.com
2. Follow the quick start guide
3. Start building
`

export const SA_FAQ_MD = `# FAQ

**Q: What is My Product?**
A: My Product is a platform for doing amazing things. Replace this with your actual FAQ.

**Q: How do I get help?**
A: Ask in the support channel — our support agent will respond!
`

export const SA_ENV_EXAMPLE = `# Required — auto-injected in production via supported_providers
ANTHROPIC_API_KEY=

# --- Discord (optional) ---
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_IDS=

# --- Telegram (optional) ---
TELEGRAM_BOT_TOKEN=

# --- Slack (optional) ---
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
`
