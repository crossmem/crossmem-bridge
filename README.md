# crossmem-bridge

WebSocket bridge between CLI/AI agents and the [crossmem Chrome extension](https://chromewebstore.google.com/detail/crossmem/kmpfhoimimgfdglaglpjegjiahkfolpa).

Control your browser from the terminal. No Puppeteer, no headless Chrome — uses your real browser with your real login sessions.

## Quick Start

```bash
npx crossmem-bridge
```

Then install the [crossmem extension](https://chromewebstore.google.com/detail/crossmem/kmpfhoimimgfdglaglpjegjiahkfolpa) if you haven't already.

## What it does

- Bridges CLI commands to your Chrome browser via the crossmem extension
- Routes LLM requests to your local Claude Code (uses your subscription, not API credits)
- Saves snapshots and summaries to `~/crossmem/{raw,wiki}`
- Downloads arxiv PDFs automatically

## API

```bash
# Check status
curl http://127.0.0.1:7600/status

# Send commands
curl -X POST http://127.0.0.1:7600/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}'
```

### Available actions

| Action | Params | Description |
|--------|--------|-------------|
| `navigate` | `{url}` | Open a URL |
| `click` | `{selector}` | Click an element |
| `type` | `{selector, text}` | Type into an element |
| `wait` | `{selector, timeout?}` | Wait for element |
| `extract` | `{selector, attr?}` | Extract text/attributes |
| `screenshot` | — | Capture visible tab |
| `summarize` | — | Snapshot & Summary current page |
| `ping` | — | Health check |

## Requirements

- Node.js >= 18
- Chrome with crossmem extension installed
- (Optional) Claude Code CLI for LLM features via subscription
