# MCP in Unsloth Studio

## MCP Apps: widgets in the chat

An MCP server can ship a user interface with its tools: the tool declares a
`ui://` template in its metadata, and instead of only printing text, Unsloth
Studio renders the template as an interactive widget inline in the
conversation. The published `@modelcontextprotocol/server-pdf` viewer is the
reference example: ask for a paper and the PDF appears in the chat, with
pagination, search and zoom that stay live while the conversation continues.

Requirements: a tool-capable model, MCP enabled for the chat (the composer's
MCP pill), and a server that declares UI resources. Studio announces the
`io.modelcontextprotocol/ui` extension during the MCP handshake, so servers
that gate their UI tools on host support register them for Studio.

**Where the widget runs.** Each server's widgets are served from their own
local origin — a second port on the same address Studio is reached on — and
run sandboxed inside it. The widget cannot reach Studio's own storage or
cookies, and one server's widgets cannot read another's. The caption under a
widget names the outside hosts its template asked to reach; everything else is
blocked by a default-deny content security policy built from the server's own
declaration. Where no second origin is available (for example behind an HTTPS
tunnel that cannot frame plain HTTP), the widget falls back to a stricter
isolated mode and says so under the widget.

**What the model sees and does.** The widget mounts while the model is still
writing the tool's arguments and receives them as they stream in; when the
result lands, the widget is seeded with it without reloading. A widget can
report its state to the model (`ui/update-model-context`); the model reads the
last report before each of your messages, images included on
image-capable models. A widget can also ask to send a chat message as you —
that always shows a Send / Don't send prompt first, and its own tool calls go
through the chat's permission level (Allow / Deny / Always allow), exactly like
the model's calls.

**Leaving and returning.** Switching conversations tells each widget it is
going and waits briefly for it to save its state (the spec's teardown
notification); the per-server origin is remembered, so a widget's own storage
survives restarts. The fullscreen button (or the widget's own, when it
declares support) expands it to the window with a floating chat bar, and
`Esc` or **Exit full screen** returns it inline.

Widgets are untrusted content: they never see Studio credentials, their
network reach is only what their server declared, and their results reach the
model as tool output, subject to the same size bounds as any tool result.

## Connect Blender MCP

Blender MCP is **disabled by default**. Unsloth Studio downloads a pinned, checksum-verified
runtime on first enable/test and caches it on the backend machine. No commands,
Git or pip installs are needed. Subsequent starts use the cache without internet.
The Blender add-on is installed separately. No MCP archive or source is shipped
in Unsloth Studio's Python package or desktop build.

1. Open **Manage MCP servers → Blender**, approve the execution warning and choose
   **Enable Blender MCP**. Use a tool-capable model with MCP enabled for the chat.
2. Open **Setup help → Download Blender add-on** for
   [Blender's official page](https://www.blender.org/lab/mcp-server/).
3. In Blender 5.1+, enable **Preferences → System → Network → Allow Online Access**.
   Drag the website's install button into Blender twice: first to add the Blender
   Lab repository, then to install MCP. Alternatively, search **MCP** in
   **Get Extensions** after adding the repository.
4. Enable and start the add-on bridge, keep Blender open, then **Test connection**.

A green dot means Blender is connected; amber means only the MCP server is connected.
Setup help stays in the same Blender entry. Advanced settings configure the bridge
port (default `9876`) and optional Blender executable. This port is not an HTTP URL.

The bridge uses loopback on the **Unsloth Studio backend machine**, not a remote browser.
Unsloth Studio does not install or launch Blender during setup. Approved tools can run
Python, write files and launch background Blender. Existing tool permissions apply;
external model providers receive tool results. Keep the unauthenticated bridge local.

The downloaded runtime excludes the large API/manual reference corpus and its three
offline documentation tools. The official source is
https://projects.blender.org/lab/blender_mcp (GPL-3.0-or-later).
The pinned revision and SHA-256 are in `backend/integrations/blender/runtime.py`.
Downloads are staged and verified before activation; failures leave the server
disabled and can be retried with **Enable Blender MCP**. Merely opening the dialog
or launching Unsloth Studio does not download anything.

## Large tool catalogs

A server can expose dozens of tools with long descriptions and deeply nested
parameter schemas: Notion's catalog alone is about 65,000 tokens. Every tool is
listed in full whenever the catalog fits the loaded local model's context window,
so a model that can hold the full listing always gets it.

When the full listing would take more than three quarters of the window, which
would otherwise get even a short prompt refused, the largest tools (only those
whose description and schema together exceed about 1,500 characters) are listed
in a compact form, largest first, until the listing fits: a compact tool shows its
first sentence plus its top-level parameters with their types, required flags and
short enums. Every other tool keeps its full schema. The model then also gets `mcp_tool_schema`, which returns a tool's
full description and JSON Schema on demand, in pages when it is longer than the
room left for a tool result. A compact tool called without one of its required
arguments, or whose call the server rejects, answers with that schema so the model
can correct the call. Arguments to a compact tool are still typed against its full
schema. External providers always get the full listing.

## Unsloth Decisions MCP

When the Decision API is on (**Settings → API**), the chat's MCP menu lists
**Unsloth Decisions**. Enable it and a tool-capable chat model can call `decide`,
which asks the local Laya model the same typed questions `POST /v1/systemone`
answers (`noul`, `choice` and `score`), with the model chosen in Settings.

Other MCP clients reach the same tool at `http://127.0.0.1:8888/mcp/decisions/`
(use the actual Unsloth port). It takes the credentials `/v1/systemone` takes, so
send an Unsloth API key as `Authorization: Bearer sk-unsloth-...`.

<a id="studios-own-mcp-server"></a>

## Unsloth Studio's own MCP server

Unsloth can expose a local MCP server so an MCP client can inspect models and
GPU state, validate recipes, start or stop training, inspect recipe output, and
export a loaded model.

The server is disabled by default. Enable it for a local Unsloth process with:

```bash
UNSLOTH_STUDIO_ENABLE_MCP=1 \
UNSLOTH_STUDIO_MCP_TOKEN='use-a-local-secret' \
unsloth studio
```

The endpoint is `http://127.0.0.1:8888/mcp/` when Unsloth uses its default port
(a request to `/mcp` redirects to the canonical `/mcp/`). Use the actual Unsloth
port when it is configured differently.

The high-impact tools are:

- `studio_status` and `list_local_models` for discovery
- `get_training_status`, `start_training`, `stop_training`, and `list_training_runs`
- `validate_recipe`, `get_recipe_job_status`, and `get_recipe_job_dataset`
- `load_checkpoint` and `export_gguf`

`start_training` accepts the same fields as the Unsloth `TrainingStartRequest`.
The request is validated by the existing Pydantic model before a subprocess is
started. Export paths use the existing Unsloth validation as well.

The endpoint always requires `UNSLOTH_STUDIO_MCP_TOKEN` and checks an exact
Bearer token for both HTTP and WebSocket connections. Keep it on localhost
unless the deployment has an authenticated reverse proxy. The MCP endpoint is
intentionally opt-in because tools can consume GPU memory, write model
artifacts, and stop active work.