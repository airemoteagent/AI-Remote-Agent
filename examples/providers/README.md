# BYO providers — bring your own LLM keys

Since v2.10.1 mona-agent can run its brain on-device with **your** keys
instead of the cloud vault. Prompts never leave the machine, and the
local policy file still gates every tool.

## Provider templates

Copy a template to `~/.mona-agent/provider.json` (`chmod 600`), or use
the CLI, which writes the 0600 file for you:

```bash
mona-agent provider set anthropic              # asks for the key
mona-agent provider set openai --model gpt-4o-mini
mona-agent provider set openai --url http://localhost:1234/v1 --model llama-3   # LM Studio / vLLM
mona-agent provider set ollama --model qwen2.5:7b
mona-agent provider test                      # one-shot smoke test
```

## anthropic.json

```json
{
  "provider": "anthropic",
  "apiKey":   "sk-ant-...",
  "model":    "claude-3-5-sonnet-20241022"
}
```

## openai-compatible.json

Works for OpenAI, OpenRouter, Groq, LM Studio, vLLM and any endpoint
speaking `POST /chat/completions`. `baseUrl` is everything before
`/chat/completions`.

```json
{
  "provider": "openai",
  "apiKey":   "sk-...",
  "baseUrl":  "https://api.openai.com",
  "model":    "gpt-4o-mini"
}
```

## ollama.json — fully offline, $0

```json
{
  "provider": "ollama",
  "baseUrl":  "http://127.0.0.1:11434",
  "model":    "llama3.2"
}
```

No API key. `ollama pull llama3.2` first, then run the agent with the
daemon stopped from calling home for reasoning:

```bash
MONA_TRANSPORT=local mona-agent start
```

## Cost governance

BYO tokens are priced from a local table (per 1M tokens) so the budget
governor keeps working. Override per provider:

```json
{ "provider": "openai", "apiKey": "sk-...", "model": "my-model",
  "prices": { "input": 0.5, "output": 1.5 } }
```

Show what will be charged: `mona-agent provider status`. Every task's
token and cost trace lands in `mona-agent audit tail` and the run trace.
