#!/usr/bin/env python3
"""
Agent runner — standalone script for local and sandbox execution.

Implements a tool-use loop: the LLM receives the author's prompt as the system
message and the caller's input as the user message, then iterates with tools
until it calls submit_result or reaches max_turns.

Built-in tools: bash, read_file, write_file, list_files, submit_result
Custom tools: command wrappers defined by the agent author in custom_tools.json

Supports multiple LLM providers: anthropic, openai, gemini.
Set LLM_PROVIDER env var to select (default: anthropic).

When LOCAL_MODE=1 is set, adapts platform context for local execution
(no sandbox references, uses actual working directory).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading

# ---------------------------------------------------------------------------
# Tool definitions (canonical format — Anthropic-style)
# ---------------------------------------------------------------------------

BUILTIN_TOOLS = [
    {
        "name": "bash",
        "description": "Run a shell command and return stdout + stderr. Use for installing packages, running tests, compiling code, and other system operations. Commands time out after 120 seconds.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute",
                }
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file. Returns the full file content as a string.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file",
                }
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file. Creates the file and any parent directories if they don't exist. Overwrites existing content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file",
                },
                "content": {
                    "type": "string",
                    "description": "The content to write to the file",
                },
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "list_files",
        "description": "List files and directories at the given path.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list (default: current directory)",
                    "default": ".",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "If true, list files recursively",
                    "default": False,
                },
            },
        },
    },
]

BASH_TIMEOUT = 120  # seconds per command


def error_exit(msg):
    print(json.dumps({"error": msg}))
    sys.exit(1)


def build_platform_context(output_schema, custom_tools_config):
    """Build platform context prepended to the author's prompt.

    This eliminates the need for authors to explain sandbox mechanics
    (tools, file locations, submit_result usage) in their prompt.md.
    The author's prompt can focus purely on domain expertise.
    """
    is_local = os.environ.get("LOCAL_MODE") == "1"

    lines = []
    lines.append("[PLATFORM CONTEXT — auto-injected by orchagent]")
    lines.append("")
    lines.append("## Environment")
    if is_local:
        lines.append("You are running locally. Working directory: %s" % os.getcwd())
    else:
        lines.append("You are running inside an isolated sandbox. Working directory: /home/user")
        lines.append("Uploaded files (if any): /tmp/uploads/")
    lines.append("")
    lines.append("## Tools")
    lines.append("- **bash**: Run shell commands (120s timeout per command)")
    lines.append("- **read_file**: Read a file's contents")
    lines.append("- **write_file**: Create or overwrite a file (parent dirs created automatically)")
    lines.append("- **list_files**: List directory contents")

    if custom_tools_config:
        for ct in custom_tools_config:
            desc = ct.get("description", ct.get("command", ""))
            lines.append("- **%s**: %s" % (ct["name"], desc))

    # Check for skills
    skills_path = "/home/user/orchagent/skills/manifest.json"
    if is_local:
        skills_path = os.path.join(os.getcwd(), "orchagent", "skills", "manifest.json")
    if os.path.exists(skills_path):
        try:
            with open(skills_path, "r") as f:
                skills = json.load(f)
            if skills:
                lines.append("")
                lines.append("## Skills")
                lines.append("Reference material is available:")
                for skill in skills:
                    lines.append("- %s — %s" % (skill.get("name", ""), skill.get("description", "")))
        except Exception:
            pass

    lines.append("")
    lines.append("## Submitting Results")
    if output_schema:
        schema_str = json.dumps(output_schema, indent=2)
        lines.append("When done, call **submit_result** with output matching this schema:")
        lines.append("```json")
        lines.append(schema_str)
        lines.append("```")
    else:
        lines.append("When done, call **submit_result** with a JSON object containing your result.")

    lines.append("")
    lines.append("[END PLATFORM CONTEXT]")
    lines.append("")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


def build_submit_result_tool(output_schema):
    """Build the submit_result tool definition."""
    if output_schema:
        input_schema = output_schema
    else:
        input_schema = {
            "type": "object",
            "properties": {
                "result": {
                    "type": "string",
                    "description": "The final result to return",
                }
            },
        }
    return {
        "name": "submit_result",
        "description": "Submit the final result. Call this when you have completed the task. The input must match the agent's output schema.",
        "input_schema": input_schema,
    }


def build_custom_tools(custom_tools_config):
    """Convert author-defined custom tool configs to canonical tool format."""
    tools = []
    for ct in custom_tools_config:
        tool_def = {
            "name": ct["name"],
            "description": ct.get("description", "Run: " + ct["command"]),
        }
        if ct.get("input_schema"):
            tool_def["input_schema"] = ct["input_schema"]
        else:
            # No-parameter tool: empty object schema
            tool_def["input_schema"] = {"type": "object", "properties": {}}
        tools.append(tool_def)
    return tools


# ---------------------------------------------------------------------------
# Structured event emission for real-time streaming
# ---------------------------------------------------------------------------

def emit_event(event_type, **kwargs):
    """Emit a structured event to stderr for the gateway to capture."""
    event = {"type": event_type, **kwargs}
    print("@@ORCHAGENT_EVENT:" + json.dumps(event), file=sys.stderr, flush=True)

def _brief_args(tool_name, args):
    """Short safe summary of tool args for streaming display."""
    if tool_name == "bash":
        cmd = args.get("command", "")
        return cmd[:120] + ("..." if len(cmd) > 120 else "")
    if tool_name == "read_file":
        return args.get("path", "")[:100]
    if tool_name == "write_file":
        return "%s (%d chars)" % (args.get("path", "")[:80], len(args.get("content", "")))
    if tool_name == "list_files":
        return args.get("path", ".")
    if tool_name == "submit_result":
        return ""
    try:
        s = json.dumps(args)
        return s[:100] + ("..." if len(s) > 100 else "")
    except Exception:
        return "..."


# ---------------------------------------------------------------------------
# Verbose logging for local mode
# ---------------------------------------------------------------------------

_VERBOSE = False

def verbose_log(tool_name, tool_input):
    """Log tool call to stderr in human-readable format when --verbose is set."""
    if not _VERBOSE:
        return
    if tool_name == "bash":
        cmd = tool_input.get("command", "")
        display = cmd[:100] + ("..." if len(cmd) > 100 else "")
        print("  - bash: %s" % display, file=sys.stderr, flush=True)
    elif tool_name == "read_file":
        print("  - read_file: %s" % tool_input.get("path", ""), file=sys.stderr, flush=True)
    elif tool_name == "write_file":
        print("  - write_file: %s" % tool_input.get("path", ""), file=sys.stderr, flush=True)
    elif tool_name == "list_files":
        print("  - list_files: %s" % tool_input.get("path", "."), file=sys.stderr, flush=True)
    elif tool_name == "submit_result":
        print("  - submit_result", file=sys.stderr, flush=True)
    else:
        print("  - %s" % tool_name, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------

def execute_bash(command):
    """Execute a bash command with timeout."""
    try:
        result = subprocess.run(
            ["bash", "-c", command],
            capture_output=True,
            text=True,
            timeout=BASH_TIMEOUT,
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += ("\n" if output else "") + "STDERR:\n" + result.stderr
        if result.returncode != 0:
            output += "\n[exit code: %d]" % result.returncode
        return output or "(no output)"
    except subprocess.TimeoutExpired:
        return "[ERROR] Command timed out after %d seconds" % BASH_TIMEOUT
    except Exception as e:
        return "[ERROR] %s" % e


def execute_read_file(path):
    """Read a file's contents."""
    try:
        with open(path, "r") as f:
            return f.read()
    except FileNotFoundError:
        return "[ERROR] File not found: " + path
    except Exception as e:
        return "[ERROR] %s" % e


def execute_write_file(path, content):
    """Write content to a file, creating parent dirs."""
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        return "Successfully wrote %d bytes to %s" % (len(content), path)
    except Exception as e:
        return "[ERROR] %s" % e


def execute_list_files(path=".", recursive=False):
    """List files in a directory."""
    try:
        if recursive:
            entries = []
            for root, dirs, files in os.walk(path):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for f in files:
                    if not f.startswith("."):
                        entries.append(os.path.relpath(os.path.join(root, f), path))
            return "\n".join(sorted(entries)) or "(empty directory)"
        else:
            entries = sorted(os.listdir(path))
            result = []
            for e in entries:
                full = os.path.join(path, e)
                suffix = "/" if os.path.isdir(full) else ""
                result.append(e + suffix)
            return "\n".join(result) or "(empty directory)"
    except FileNotFoundError:
        return "[ERROR] Directory not found: " + path
    except Exception as e:
        return "[ERROR] %s" % e


def execute_custom_tool(command_template, params):
    """Execute a custom tool by substituting params into the command template."""
    # Write params as JSON for tools that prefer structured input
    with open("/tmp/__tool_input.json", "w") as f:
        json.dump(params, f)
    command = command_template
    for key, value in params.items():
        safe_value = str(value).replace("'", "'\\''")
        command = command.replace("{{" + key + "}}", safe_value)
    command = re.sub(r"\{\{\w+\}\}", "", command)
    return execute_bash(command)


def dispatch_tool(tool_name, tool_input, custom_tools_config):
    """
    Dispatch a tool call. Returns (result_text, is_submit).
    is_submit is True only when tool_name == "submit_result".
    """
    if tool_name == "bash":
        return execute_bash(tool_input.get("command", "")), False
    elif tool_name == "read_file":
        return execute_read_file(tool_input.get("path", "")), False
    elif tool_name == "write_file":
        return execute_write_file(
            tool_input.get("path", ""),
            tool_input.get("content", ""),
        ), False
    elif tool_name == "list_files":
        return execute_list_files(
            tool_input.get("path", "."),
            tool_input.get("recursive", False),
        ), False
    elif tool_name == "submit_result":
        return json.dumps(tool_input), True
    else:
        for ct in custom_tools_config:
            if ct["name"] == tool_name:
                return execute_custom_tool(ct["command"], tool_input), False
        return "[ERROR] Unknown tool: " + tool_name, False


# ---------------------------------------------------------------------------
# Provider abstraction
# ---------------------------------------------------------------------------

class AnthropicProvider:
    name = "anthropic"

    def import_sdk(self):
        import anthropic
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            error_exit("ANTHROPIC_API_KEY not set")
        self.client = anthropic.Anthropic(api_key=key)
        self.model = os.environ.get("LLM_MODEL", "claude-sonnet-4-5-20250929")

    def convert_tools(self, tools):
        return tools  # Already in canonical (Anthropic) format

    def call(self, system, messages, tools):
        return self.client.messages.create(
            model=self.model, max_tokens=16384,
            system=system, tools=tools, messages=messages)

    def has_tool_use(self, r):
        return any(b.type == "tool_use" for b in r.content)

    def extract_text(self, r):
        return "\n".join(b.text for b in r.content if b.type == "text")

    def extract_tool_calls(self, r):
        for b in r.content:
            if b.type == "tool_use":
                yield b.id, b.name, b.input

    def append_turn(self, messages, response, tool_results):
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for call_id, name, text, is_err in tool_results:
            r = {"type": "tool_result", "tool_use_id": call_id, "content": text}
            if is_err:
                r["is_error"] = True
            results.append(r)
        messages.append({"role": "user", "content": results})


class OpenAIProvider:
    name = "openai"

    def import_sdk(self):
        import openai
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            error_exit("OPENAI_API_KEY not set")
        self.client = openai.OpenAI(api_key=key)
        self.model = os.environ.get("LLM_MODEL", "gpt-4o")

    def convert_tools(self, tools):
        """Wrap canonical tools into OpenAI function-calling format."""
        converted = []
        for t in tools:
            converted.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
                },
            })
        return converted

    def call(self, system, messages, tools):
        oai_messages = [{"role": "system", "content": system}] + messages
        return self.client.chat.completions.create(
            model=self.model, max_tokens=16384,
            tools=tools, messages=oai_messages)

    def has_tool_use(self, r):
        return bool(r.choices[0].message.tool_calls)

    def extract_text(self, r):
        return r.choices[0].message.content or ""

    def extract_tool_calls(self, r):
        for tc in r.choices[0].message.tool_calls:
            yield tc.id, tc.function.name, json.loads(tc.function.arguments)

    def append_turn(self, messages, response, tool_results):
        msg = response.choices[0].message
        # Build assistant message dict with tool_calls
        asst = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            asst["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ]
        messages.append(asst)
        # Each tool result is a separate message for OpenAI
        for call_id, name, text, is_err in tool_results:
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": text,
            })


class GeminiProvider:
    name = "gemini"

    def _sanitize_schema(self, schema):
        """Recursively strip keys Gemini doesn't support."""
        if not isinstance(schema, dict):
            return schema
        schema = dict(schema)
        for key in ("$schema", "additionalProperties", "examples", "default", "title"):
            schema.pop(key, None)
        schema_type = (schema.get("type") or "").lower()
        if schema_type == "object":
            props = schema.get("properties")
            if not props or not isinstance(props, dict) or len(props) == 0:
                schema["type"] = "STRING"
                schema.pop("properties", None)
                schema.pop("required", None)
            else:
                sanitized = {}
                for k, v in props.items():
                    cleaned = self._sanitize_schema(v)
                    if cleaned is not None:
                        sanitized[k] = cleaned
                schema["properties"] = sanitized
        elif schema_type == "array":
            items = schema.get("items")
            if isinstance(items, dict):
                schema["items"] = self._sanitize_schema(items)
        return schema

    def import_sdk(self):
        from google import genai
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            error_exit("GEMINI_API_KEY not set")
        self.client = genai.Client(api_key=key)
        self.model = os.environ.get("LLM_MODEL", "gemini-2.5-pro")
        self._genai_types = __import__("google.genai", fromlist=["types"]).types

    def convert_tools(self, tools):
        """Convert canonical tools to Gemini function declarations."""
        types = self._genai_types
        declarations = []
        for t in tools:
            schema = t.get("input_schema", {"type": "object", "properties": {}})
            sanitized = self._sanitize_schema(schema)
            declarations.append(types.FunctionDeclaration(
                name=t["name"],
                description=t.get("description", ""),
                parameters=sanitized,
            ))
        return [types.Tool(function_declarations=declarations)]

    def call(self, system, messages, tools):
        types = self._genai_types
        # Convert messages to Gemini Content format
        contents = []
        for msg in messages:
            role = msg["role"] if isinstance(msg, dict) else getattr(msg, "role", "user")
            # If msg is already a genai Content object, pass through
            if hasattr(msg, "parts"):
                contents.append(msg)
                continue
            gemini_role = "user" if role == "user" else "model"
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, str):
                contents.append(types.Content(
                    role=gemini_role,
                    parts=[types.Part.from_text(text=content)],
                ))
            elif isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, dict) and "function_response" in item:
                        fr = item["function_response"]
                        parts.append(types.Part.from_function_response(
                            name=fr["name"],
                            response=fr["response"],
                        ))
                    else:
                        parts.append(types.Part.from_text(text=str(item)))
                contents.append(types.Content(role=gemini_role, parts=parts))
        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=tools,
            max_output_tokens=16384,
        )
        return self.client.models.generate_content(
            model=self.model, contents=contents, config=config)

    def has_tool_use(self, r):
        if not r.candidates or not r.candidates[0].content:
            return False
        return any(p.function_call for p in r.candidates[0].content.parts)

    def extract_text(self, r):
        if not r.candidates or not r.candidates[0].content:
            return ""
        parts = []
        for p in r.candidates[0].content.parts:
            if p.text:
                parts.append(p.text)
        return "\n".join(parts)

    def extract_tool_calls(self, r):
        for i, p in enumerate(r.candidates[0].content.parts):
            if p.function_call:
                yield str(i), p.function_call.name, dict(p.function_call.args)

    def append_turn(self, messages, response, tool_results):
        types = self._genai_types
        # Append the model's response as a Content object
        model_parts = []
        for p in response.candidates[0].content.parts:
            if p.function_call:
                model_parts.append(types.Part.from_function_call(
                    name=p.function_call.name,
                    args=dict(p.function_call.args),
                ))
            elif p.text:
                model_parts.append(types.Part.from_text(text=p.text))
        messages.append(types.Content(role="model", parts=model_parts))
        # Append function responses as user message
        fr_parts = []
        for call_id, name, text, is_err in tool_results:
            try:
                resp_data = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                resp_data = {"output": text}
            if is_err:
                resp_data = {"error": text}
            # Gemini requires response to be a dict
            if not isinstance(resp_data, dict):
                resp_data = {"output": resp_data}
            fr_parts.append(types.Part.from_function_response(
                name=name, response=resp_data,
            ))
        messages.append(types.Content(role="user", parts=fr_parts))


PROVIDERS = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "gemini": GeminiProvider,
}


class Heartbeat:
    """Print periodic markers to stderr to keep E2B connection alive during LLM calls."""
    def __init__(self, interval=15):
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None

    def __enter__(self):
        def _beat():
            while not self._stop.wait(self.interval):
                print(".", end="", file=sys.stderr, flush=True)
        self._thread = threading.Thread(target=_beat, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


# ---------------------------------------------------------------------------
# Main agent loop
# ---------------------------------------------------------------------------

def main():
    global _VERBOSE

    parser = argparse.ArgumentParser()
    parser.add_argument("--max-turns", type=int, default=25)
    parser.add_argument("--verbose", action="store_true", help="Log tool calls to stderr")
    args = parser.parse_args()

    _VERBOSE = args.verbose

    with open("prompt.md", "r") as f:
        author_prompt = f.read()

    with open("input.json", "r") as f:
        input_data = json.load(f)

    output_schema = None
    if os.path.exists("output_schema.json"):
        with open("output_schema.json", "r") as f:
            output_schema = json.load(f)

    custom_tools_config = []
    if os.path.exists("custom_tools.json"):
        with open("custom_tools.json", "r") as f:
            custom_tools_config = json.load(f)

    # Prepend platform context so authors don't need to explain sandbox mechanics
    system_prompt = build_platform_context(output_schema, custom_tools_config) + author_prompt

    # Build canonical tool list
    canonical_tools = list(BUILTIN_TOOLS)
    canonical_tools.append(build_submit_result_tool(output_schema))
    canonical_tools.extend(build_custom_tools(custom_tools_config))

    # Select and initialize provider
    provider_name = os.environ.get("LLM_PROVIDER", "anthropic")
    if provider_name not in PROVIDERS:
        error_exit("Unsupported LLM_PROVIDER: %s. Supported: %s" % (provider_name, ", ".join(PROVIDERS)))

    provider = PROVIDERS[provider_name]()
    try:
        provider.import_sdk()
    except ImportError as e:
        error_exit("Failed to import SDK for %s: %s" % (provider_name, e))
    except Exception as e:
        error_exit("Failed to initialize %s provider: %s" % (provider_name, e))

    tools = provider.convert_tools(canonical_tools)

    messages = [{"role": "user", "content": json.dumps(input_data, indent=2)}]

    for turn in range(args.max_turns):
        emit_event("turn_start", turn=turn + 1, max_turns=args.max_turns)
        if _VERBOSE:
            print("[agent] Turn %d/%d" % (turn + 1, args.max_turns), file=sys.stderr, flush=True)

        with Heartbeat(interval=15):
            try:
                response = provider.call(system_prompt, messages, tools)
            except Exception as e:
                emit_event("error", message=str(e)[:200])
                error_exit("LLM API error (%s): %s" % (provider_name, e))

        if not provider.has_tool_use(response):
            emit_event("done")
            final_text = provider.extract_text(response)
            try:
                result = json.loads(final_text)
                print(json.dumps(result))
            except json.JSONDecodeError:
                print(json.dumps({"result": final_text}))
            sys.exit(0)

        tool_results = []
        for call_id, name, input_args in provider.extract_tool_calls(response):
            verbose_log(name, input_args)
            emit_event("tool_call", turn=turn + 1, tool=name, args_brief=_brief_args(name, input_args))
            result_text, is_submit = dispatch_tool(name, input_args, custom_tools_config)
            emit_event("tool_result", turn=turn + 1, tool=name, status="error" if result_text.startswith("[ERROR]") else "ok")

            if is_submit:
                emit_event("done")
                try:
                    result = json.loads(result_text)
                except json.JSONDecodeError:
                    result = {"result": result_text}
                print(json.dumps(result))
                sys.exit(0)

            is_error = result_text.startswith("[ERROR]")
            tool_results.append((call_id, name, result_text, is_error))

        provider.append_turn(messages, response, tool_results)
        num_calls = len(tool_results)
        if _VERBOSE:
            print("[agent] Turn %d/%d completed (%d tool calls)" % (turn + 1, args.max_turns, num_calls), file=sys.stderr, flush=True)
        else:
            print("[agent] Turn %d/%d completed (%d tool calls)" % (turn + 1, args.max_turns, num_calls), file=sys.stderr)

    emit_event("error", message="max turns reached")
    error_exit("Agent reached maximum turns (%d) without submitting a result" % args.max_turns)


if __name__ == "__main__":
    main()
