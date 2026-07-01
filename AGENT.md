# LexVerdict — Build Spec

## Identity
- **Name:** LexVerdict
- **Series:** Lex (LatticeAG edge AI infrastructure)
- **Tagline:** Post-execution verification API — pass or steer in milliseconds.
- **Product page:** https://latticeag.vercel.app/products/lexverdict
- **Status:** Invite-only PoC
- **Deploy target:** Cloudflare Workers

## What It Is

A Cloudflare Worker that acts as a verifying proxy. It:
1. Receives requests to POST /v1/chat/completions (OpenAI-compatible)
2. Forwards the request to an upstream model API (configurable)
3. Waits for the full response from upstream (buffers it)
4. Sends the response to Jimmy (a 15k TPS Llama 3.1 8B endpoint) for verification
5. If Jimmy says "pass" — forward the original response to the client unchanged
6. If Jimmy says "steer" — inject a steering system message into the response before forwarding

Also exposes a standalone POST /v1/verify endpoint for direct verification calls.

## Architecture

```
Client -> LexVerdict Worker -> Upstream API (any OpenAI-compatible)
                              -> Jimmy (verifier, 15k TPS)
                              -> Client (verified response)
```

## File Structure

```
lexverdict/
├── src/
│   ├── index.ts          # Worker entry point, route handler
│   ├── proxy.ts          # Upstream forwarding + response buffering
│   └── verify.ts         # Jimmy call + verdict parsing
├── wrangler.toml
├── package.json
├── tsconfig.json
└── README.md (already exists)
```

## API Surface

### POST /v1/chat/completions (proxy mode)

Standard OpenAI chat completions endpoint. Forwards to UPSTREAM_URL.

**Request:**
```json
{
  "model": "any-model-name",
  "messages": [{"role": "user", "content": "..."}],
  "stream": true/false,
  "max_tokens": 1000
}
```

**Behavior:**
- Receives full response from upstream (buffers it)
- Sends to Jimmy for verification: `{request: original_messages, response: upstream_output}`
- If Jimmy verdict is "pass" -> forward upstream response as-is
- If Jimmy verdict is "steer" -> inject system message with steering content into response, then forward
- Supports both streaming (single SSE chunk from upstream) and non-streaming

**The Jimmy verification prompt:**
```
You are a response verifier. Given the user's request and the model's response, check if the response is correct and on-track.

Request: {the original user messages}
Response: {the model's output}

Answer with exactly:
VERDICT: PASS or STEER
CONFIDENCE: 0.0-1.0
MESSAGE: (only if STEER - explain what's wrong and what to do)
```

**Streaming handling:** The upstream sends the entire response as one big SSE data chunk (not token-by-token). Buffer that single chunk, call Jimmy, then either forward the chunk as-is (pass) or modify the content to include the steering message before forwarding.

**Non-streaming:** Buffer the full JSON response, call Jimmy, modify choices[0].message.content if steering is needed.

### POST /v1/verify (standalone mode)

Direct verification endpoint. Does NOT call upstream — just checks a tool result.

**Request:**
```json
{
  "tool_call": "write_file config.yaml",
  "goal": "Deploy to production",
  "result": "Config written with env: staging"
}
```

**Response:**
```json
{
  "verdict": "steer",
  "confidence": 0.92,
  "message": "[LexVerdict] Config references 'staging' but goal was 'production'. Verify and correct before continuing."
}
```

## Configuration (wrangler.toml vars)

```toml
[vars]
UPSTREAM_URL = "https://api.openai.com"
UPSTREAM_API_KEY = ""  # if empty, client's own key passes through
JIMMY_URL = "https://your-verifier.workers.dev/v1/chat/completions"
```

## Implementation Details

### Streaming Response Modification

When streaming and verdict is "steer", the Worker needs to:
1. Parse the SSE chunk from upstream (one big data event with full content)
2. Modify the content to prepend or inject the steering message
3. Forward the modified SSE chunk to the client

The steering message format for injection:
```json
{"role": "system", "content": "[LexVerdict] <steer message>"}
```

For streaming, this can be sent as a separate SSE data event before the upstream's content event.

### Non-Streaming Response Modification

For non-streaming, the steering message goes into the response as an additional message in the choices array or prepended to the content.

## Build Order

1. Scaffold the worker (package.json, wrangler.toml, tsconfig.json, src/)
2. Implement proxy.ts — forward upstream, buffer response
3. Implement verify.ts — call Jimmy, parse verdict
4. Implement index.ts — route to proxy or verify
5. Test with curl against the dev server

## Links

- Jimmy endpoint: https://your-verifier.workers.dev/v1/chat/completions
- Product page: https://latticeag.vercel.app/products/lexverdict
- Existing README: /home/ubuntu/repos/lexverdict/README.md
