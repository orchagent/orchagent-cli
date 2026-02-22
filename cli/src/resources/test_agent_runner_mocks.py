"""
Tests for mock tool support in agent_runner.py.

IDEA-002: Validates that dispatch_tool correctly returns mock responses
for custom tools when mock_tools map is provided, and that built-in
tools are never mocked.
"""

import json
import os
import sys
import tempfile

# Add the resources directory to path so we can import agent_runner
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# We need to test dispatch_tool in isolation, so import it directly
from agent_runner import dispatch_tool, execute_bash


def test_mock_tool_returns_dict_response():
    """Mock tool with dict response returns JSON string."""
    mock_tools = {
        "scan_secrets": {"findings": [{"type": "hardcoded_key"}]},
    }
    custom_tools = [
        {"name": "scan_secrets", "command": "echo should_not_run"},
    ]

    result, is_submit = dispatch_tool("scan_secrets", {"path": "/code"}, custom_tools, mock_tools)

    assert is_submit is False
    parsed = json.loads(result)
    assert parsed == {"findings": [{"type": "hardcoded_key"}]}


def test_mock_tool_returns_string_response():
    """Mock tool with string response returns the string directly."""
    mock_tools = {
        "scan_secrets": "raw string response",
    }
    custom_tools = [
        {"name": "scan_secrets", "command": "echo should_not_run"},
    ]

    result, is_submit = dispatch_tool("scan_secrets", {}, custom_tools, mock_tools)

    assert is_submit is False
    assert result == "raw string response"


def test_mock_tool_returns_list_response():
    """Mock tool with list response returns JSON string."""
    mock_tools = {
        "scan_deps": [{"name": "lodash", "severity": "high"}],
    }
    custom_tools = [
        {"name": "scan_deps", "command": "echo should_not_run"},
    ]

    result, is_submit = dispatch_tool("scan_deps", {"path": "."}, custom_tools, mock_tools)

    assert is_submit is False
    parsed = json.loads(result)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "lodash"


def test_mock_tool_returns_null_response():
    """Mock tool with None/null response returns JSON null."""
    mock_tools = {
        "scan_secrets": None,
    }
    custom_tools = [
        {"name": "scan_secrets", "command": "echo should_not_run"},
    ]

    result, is_submit = dispatch_tool("scan_secrets", {}, custom_tools, mock_tools)

    assert is_submit is False
    parsed = json.loads(result)
    assert parsed is None


def test_unmocked_custom_tool_executes_normally():
    """Custom tool NOT in mock map still executes its real command."""
    mock_tools = {
        "scan_secrets": {"findings": []},
    }
    custom_tools = [
        {"name": "scan_secrets", "command": "echo should_not_run"},
        {"name": "real_tool", "command": "echo real_output"},
    ]

    result, is_submit = dispatch_tool("real_tool", {}, custom_tools, mock_tools)

    assert is_submit is False
    assert "real_output" in result


def test_builtin_bash_not_mocked():
    """Built-in bash tool is never mocked, even if in mock_tools."""
    mock_tools = {
        "bash": {"should": "not be returned"},
    }

    result, is_submit = dispatch_tool("bash", {"command": "echo hello_from_bash"}, [], mock_tools)

    assert is_submit is False
    assert "hello_from_bash" in result


def test_builtin_read_file_not_mocked():
    """Built-in read_file tool is never mocked."""
    mock_tools = {
        "read_file": "should not be returned",
    }

    # Create a temp file to read
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("real file content")
        temp_path = f.name

    try:
        result, is_submit = dispatch_tool("read_file", {"path": temp_path}, [], mock_tools)
        assert is_submit is False
        assert "real file content" in result
    finally:
        os.unlink(temp_path)


def test_builtin_write_file_not_mocked():
    """Built-in write_file tool is never mocked."""
    mock_tools = {
        "write_file": "should not be returned",
    }

    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        temp_path = f.name

    try:
        result, is_submit = dispatch_tool(
            "write_file",
            {"path": temp_path, "content": "test content"},
            [],
            mock_tools,
        )
        assert is_submit is False
        assert "Successfully wrote" in result
        with open(temp_path) as f:
            assert f.read() == "test content"
    finally:
        os.unlink(temp_path)


def test_builtin_list_files_not_mocked():
    """Built-in list_files tool is never mocked."""
    mock_tools = {
        "list_files": "should not be returned",
    }

    result, is_submit = dispatch_tool("list_files", {"path": "."}, [], mock_tools)

    assert is_submit is False
    assert result != "should not be returned"


def test_submit_result_not_mocked():
    """submit_result tool is never mocked."""
    mock_tools = {
        "submit_result": "should not be returned",
    }

    result, is_submit = dispatch_tool(
        "submit_result",
        {"result": "final answer"},
        [],
        mock_tools,
    )

    assert is_submit is True
    parsed = json.loads(result)
    assert parsed == {"result": "final answer"}


def test_no_mock_tools_dispatches_normally():
    """When mock_tools is None, custom tools execute normally."""
    custom_tools = [
        {"name": "my_tool", "command": "echo normal_execution"},
    ]

    result, is_submit = dispatch_tool("my_tool", {}, custom_tools, None)

    assert is_submit is False
    assert "normal_execution" in result


def test_empty_mock_tools_dispatches_normally():
    """When mock_tools is empty dict, custom tools execute normally."""
    custom_tools = [
        {"name": "my_tool", "command": "echo normal_execution"},
    ]

    result, is_submit = dispatch_tool("my_tool", {}, custom_tools, {})

    assert is_submit is False
    assert "normal_execution" in result


def test_unknown_tool_returns_error():
    """Unknown tool (not built-in, not custom, not mocked) returns error."""
    mock_tools = {"other_tool": {"data": "mock"}}
    custom_tools = [{"name": "other_tool", "command": "echo test"}]

    result, is_submit = dispatch_tool("nonexistent_tool", {}, custom_tools, mock_tools)

    assert is_submit is False
    assert "[ERROR]" in result
    assert "nonexistent_tool" in result


def test_mock_takes_priority_over_real_command():
    """When a tool is in both custom_tools and mock_tools, mock wins."""
    mock_tools = {
        "scan_tool": {"mocked": True},
    }
    custom_tools = [
        {"name": "scan_tool", "command": "echo REAL_COMMAND_EXECUTED"},
    ]

    result, is_submit = dispatch_tool("scan_tool", {"input": "test"}, custom_tools, mock_tools)

    assert is_submit is False
    parsed = json.loads(result)
    assert parsed == {"mocked": True}
    assert "REAL_COMMAND_EXECUTED" not in result


def test_mock_with_complex_nested_response():
    """Mock can return deeply nested JSON structures."""
    mock_tools = {
        "analyze": {
            "summary": "Code review complete",
            "findings": [
                {
                    "type": "security",
                    "severity": "critical",
                    "details": {
                        "file": "app.py",
                        "line": 42,
                        "tags": ["injection", "user-input"],
                    },
                }
            ],
            "metadata": {"tool_version": "1.0", "scan_time_ms": 150},
        },
    }
    custom_tools = [{"name": "analyze", "command": "echo noop"}]

    result, is_submit = dispatch_tool("analyze", {}, custom_tools, mock_tools)

    assert is_submit is False
    parsed = json.loads(result)
    assert parsed["findings"][0]["details"]["tags"] == ["injection", "user-input"]
    assert parsed["metadata"]["scan_time_ms"] == 150


if __name__ == "__main__":
    # Simple test runner — run all test_ functions
    passed = 0
    failed = 0
    errors = []

    for name, func in sorted(globals().items()):
        if name.startswith("test_") and callable(func):
            try:
                func()
                passed += 1
                print(f"  PASS: {name}")
            except Exception as e:
                failed += 1
                errors.append((name, e))
                print(f"  FAIL: {name} — {e}")

    print(f"\n{passed} passed, {failed} failed")
    if errors:
        for name, err in errors:
            print(f"  {name}: {err}")
        sys.exit(1)
    sys.exit(0)
