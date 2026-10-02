# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""An MCP App widget's model context reaches the model as a synthetic tool call.

The chat client puts an assistant ``mcp__studio__read_widget_context`` call and its
``role="tool"`` result ahead of the user's message (see
studio/frontend/src/features/chat/mcp-apps/model-context.ts), so widget-provided content is
never the user's words. These tests drive that pair through every request builder a Studio
turn can take and pin what each one sends: the pair must round-trip (ids matched, call before
result, nothing orphaned), the untrusted label must survive, and images must reach a vision
target through the MCP image envelope (promoted into a labelled image turn) and never a
text-only one.
"""

import asyncio
import base64
import io
import json

import httpx
import pytest
from PIL import Image

from core.inference import external_provider as ep_mod
from core.inference.external_provider import ExternalProviderClient
from models.inference import ChatMessage
from routes.inference import _build_external_messages

TOOL = "mcp__studio__read_widget_context"
CALL_ID = "call_widgetctx_abc123"
LABEL = "Untrusted data reported by interactive widgets"


def _png() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(buffer, format = "PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def _result(with_image: bool) -> str:
    text = f"{LABEL} (MCP Apps).\n\n[State of the viewer app when the user sent their next message:]\npage 7"
    if not with_image:
        return text
    return text + "\n__MCP_IMAGES__:" + json.dumps([{"data": _png(), "mimeType": "image/png"}])


def history(with_image = False, merged = False) -> list[dict]:
    """What the chat client sends: a finished turn, then the pair, then the next question.

    The client joins the call onto the reply before it (``merged``); another client may send
    it as an assistant turn of its own.
    """
    call = {"id": CALL_ID, "type": "function", "function": {"name": TOOL, "arguments": "{}"}}
    replied = (
        [{"role": "assistant", "content": "Here it is.", "tool_calls": [call]}]
        if merged
        else [
            {"role": "assistant", "content": "Here it is."},
            {"role": "assistant", "content": "", "tool_calls": [call]},
        ]
    )
    return [
        {"role": "user", "content": "Show me the report"},
        *replied,
        {"role": "tool", "tool_call_id": CALL_ID, "name": TOOL, "content": _result(with_image)},
        {"role": "user", "content": "What page am I on?"},
    ]


def built(provider_type, *, vision = True, with_image = False, merged = False, **kwargs) -> list[dict]:
    return _build_external_messages(
        [ChatMessage.model_validate(m) for m in history(with_image, merged)],
        vision,
        provider_type = provider_type,
        **kwargs,
    )


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict))


# ---- the shared builder: every external provider -----------------------------------


@pytest.mark.parametrize("merged", [True, False])
@pytest.mark.parametrize(
    "provider", ["openai", "anthropic", "gemini", "deepseek", "mistral", "openrouter", "custom"]
)
def test_the_pair_round_trips_through_the_external_builder(provider, merged):
    out = built(provider, merged = merged)
    call_at = next(i for i, m in enumerate(out) if m.get("tool_calls"))
    result_at = next(i for i, m in enumerate(out) if m["role"] == "tool")
    assert result_at == call_at + 1
    call = out[call_at]["tool_calls"][0]
    assert call["function"]["name"] == TOOL
    assert json.loads(call["function"]["arguments"]) == {}
    assert out[result_at]["tool_call_id"] == call["id"]
    assert LABEL in _text_of(out[result_at]["content"])
    # The user's turn is the user's own words, and nothing else.
    assert out[-1] == {"role": "user", "content": "What page am I on?"}


def test_widget_text_is_never_part_of_a_user_turn():
    for provider in ("openai", "anthropic", "gemini", "deepseek"):
        for message in built(provider):
            if message["role"] == "user":
                assert "page 7" not in _text_of(message["content"])


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "deepseek"])
def test_a_vision_target_gets_the_widget_image_labelled_as_the_tool_s(provider):
    out = built(provider, with_image = True)
    tool = next(m for m in out if m["role"] == "tool")
    assert "__MCP_IMAGES__" not in _text_of(tool["content"])
    assert "page 7" in _text_of(tool["content"])
    follow = out[-1]
    assert follow["role"] == "user"
    kinds = [p["type"] for p in follow["content"]]
    assert "image_url" in kinds
    assert "Images returned by the tool call above:" in _text_of(follow["content"])
    assert _text_of(follow["content"]).endswith("What page am I on?")


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "deepseek"])
def test_a_text_only_target_never_receives_the_image_or_its_marker(provider):
    out = built(provider, vision = False, with_image = True)
    blob = json.dumps(out)
    assert "__MCP_IMAGES__" not in blob
    assert "image_url" not in blob
    assert "page 7" in blob


# ---- the provider translators -----------------------------------------------------------


def _drive(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


_EMPTY_STREAMS = {
    "anthropic": (b'event: message_stop\ndata: {"type": "message_stop"}\n\n', "text/event-stream"),
    "gemini": (
        b'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],'
        b'"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n',
        "text/event-stream",
    ),
    "openai": (
        b'event: response.completed\ndata: {"type":"response.completed",'
        b'"response":{"output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
        "text/event-stream",
    ),
    "deepseek": (b"data: [DONE]\n\n", "text/event-stream"),
}
_BASE = {
    "anthropic": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
}
_MODEL = {
    "anthropic": "claude-opus-4-7",
    "gemini": "gemini-2.5-flash",
    "openai": "gpt-5.5",
    "deepseek": "deepseek-chat",
}


def sent_body(monkeypatch, provider, *, with_image = False, merged = False) -> dict:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode("utf-8"))
        content, content_type = _EMPTY_STREAMS[provider]
        return httpx.Response(200, content = content, headers = {"content-type": content_type})

    monkeypatch.setattr(
        ep_mod, "_http_client", httpx.AsyncClient(transport = httpx.MockTransport(handler))
    )

    async def run():
        client = ExternalProviderClient(
            provider_type = provider, base_url = _BASE[provider], api_key = "key"
        )
        async for _ in client.stream_chat_completion(
            messages = built(provider, with_image = with_image, merged = merged),
            model = _MODEL[provider],
            temperature = 0.7,
            top_p = 0.95,
            max_tokens = 32,
        ):
            pass
        await client.close()

    _drive(run())
    return captured["body"]


@pytest.mark.parametrize("with_image", [False, True])
def test_anthropic_pairs_a_tool_use_with_its_tool_result(monkeypatch, with_image):
    body = sent_body(monkeypatch, "anthropic", with_image = with_image)
    messages = body["messages"]
    use_at = next(
        i
        for i, m in enumerate(messages)
        if isinstance(m["content"], list) and any(b.get("type") == "tool_use" for b in m["content"])
    )
    use = next(b for b in messages[use_at]["content"] if b["type"] == "tool_use")
    assert messages[use_at]["role"] == "assistant"
    assert use["name"] == TOOL and use["input"] == {}
    # The result is the very next turn, a tool_result that comes first in it.
    nxt = messages[use_at + 1]
    assert nxt["role"] == "user"
    result = nxt["content"][0]
    assert result["type"] == "tool_result" and result["tool_use_id"] == use["id"]
    assert LABEL in result["content"]
    assert "page 7" in result["content"]
    # A tool_result carries text here; a picture is the labelled image turn beside it.
    assert "__MCP_IMAGES__" not in json.dumps(body)
    # Anthropic merges consecutive user turns, so the result, the picture and the question
    # may be separate messages; the question is the user's own, last, and the result first.
    tail = [b for m in messages[use_at + 1 :] for b in m["content"]]
    assert all(m["role"] == "user" for m in messages[use_at + 1 :])
    assert any(b.get("type") == "image" for b in tail) == with_image
    assert tail[-1].get("text") == "What page am I on?"


@pytest.mark.parametrize("merged", [True, False])
def test_gemini_call_follows_a_user_turn_and_is_answered_by_a_function_response(
    monkeypatch, merged
):
    contents = sent_body(monkeypatch, "gemini", merged = merged)["contents"]
    # Gemini 400s on a functionCall turn that does not directly follow a user turn or a
    # functionResponse: the plain "Here it is." model turn must not sit between them.
    for i, turn in enumerate(contents):
        if any("functionCall" in p for p in turn["parts"]):
            assert i > 0 and contents[i - 1]["role"] == "user", contents
            # Joined onto the reply, or an assistant turn of its own: either way one model turn.
            assert contents[i - 1]["role"] != "model"
            call = next(p["functionCall"] for p in turn["parts"] if "functionCall" in p)
            assert call["name"] == TOOL
            response = next(
                p["functionResponse"]
                for p in contents[i + 1]["parts"]
                if "functionResponse" in p
            )
            assert response["name"] == TOOL
            assert LABEL in json.dumps(response["response"])
            break
    else:
        pytest.fail("no functionCall was sent")
    # No two model turns in a row.
    roles = [t["role"] for t in contents]
    assert all(not (a == b == "model") for a, b in zip(roles, roles[1:])), roles


def test_openai_responses_sends_a_function_call_and_its_output(monkeypatch):
    items = sent_body(monkeypatch, "openai")["input"]
    call = next(i for i in items if i.get("type") == "function_call")
    output = next(i for i in items if i.get("type") == "function_call_output")
    assert call["name"] == TOOL and call["call_id"] == output["call_id"]
    assert items.index(output) == items.index(call) + 1
    assert LABEL in output["output"]


def test_chat_completions_providers_get_the_pair_untouched(monkeypatch):
    messages = sent_body(monkeypatch, "deepseek")["messages"]
    call_at = next(i for i, m in enumerate(messages) if m.get("tool_calls"))
    assert messages[call_at]["tool_calls"][0]["function"]["name"] == TOOL
    assert messages[call_at + 1]["role"] == "tool"
    assert messages[call_at + 1]["tool_call_id"] == messages[call_at]["tool_calls"][0]["id"]


# ---- local models ----------------------------------------------------------------------


def test_a_folded_local_history_keeps_the_label_and_the_tool_name():
    """A GGUF without a tool role reads a tool result as a wrapped user turn."""
    from routes.inference import _folded_studio_tool_messages

    out = _folded_studio_tool_messages(
        [ChatMessage.model_validate(m) for m in history(merged = True)]
    )
    folded = next(m for m in out if m.role == "user" and "tool_response" in str(m.content))
    # Coalesced with the question after it, so the wrapper is the start of the turn.
    payload = json.JSONDecoder().raw_decode(folded.content)[0]["tool_response"]
    assert payload["tool"] == TOOL and LABEL in payload["content"]


@pytest.mark.parametrize("merged", [True, False])
def test_local_marker_paths_promote_the_widget_image_from_the_tool_result(merged):
    from core.inference.mcp_images import promote_history_local

    result = promote_history_local(history(with_image = True, merged = merged), vision = True)
    out = result[0] if isinstance(result, tuple) else result
    tool = next(m for m in out if m["role"] == "tool")
    assert "__MCP_IMAGES__" not in tool["content"] and "page 7" in tool["content"]
    assert "Images returned by the tool call above:" in _text_of(out[-1]["content"])
