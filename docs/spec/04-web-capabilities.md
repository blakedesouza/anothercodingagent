<!-- Source: fundamentals.md lines 379-513 -->
## Foundational Block: Web Capabilities

### Operating Modes

Web capabilities depend on how the agent is being used:

- **Executor mode** (called by Claude Code, Codex, or another orchestrator): The orchestrator already has web search and fetch. This agent only needs **browser automation** for tasks the orchestrator delegates (e.g., "test this UI", "scrape this page", "fill this form"). Web search and fetch are unnecessary overhead.
- **Standalone mode** (user runs the agent directly): All three capabilities are useful — search, fetch, and browser.

**Design decision:** Browser automation (Playwright) is always available. Web search and web fetch are **optional modules** — available when configured, not required for core operation.

### Web Search (optional — standalone mode)

Programmatic web search via external search API. Only needed when the agent runs standalone.

**Architecture:** Provider-abstracted. Define a `SearchProvider` interface, start with one provider, normalize output.

| Provider | Free Tier | Quality | Notes |
|---|---|---|---|
| **Tavily** | 1,000/month | Excellent (AI-optimized) | Best quick-start option |
| **Serper** | 2,500/month | Excellent (Google results) | Best cheap Google-like |
| **Brave Search** | 2,000/month | Very good | Independent index, privacy-focused |
| **SearXNG** | Unlimited (self-hosted) | Good (aggregated) | Docker setup, no API key needed |

Start with one paid-tier provider (Tavily or Serper). Add SearXNG as unlimited fallback later. Avoid scraping search engines directly (fragile, ToS violations). Bing Search API was retired August 2025.

**Output shape:** `{ title, url, snippet, source }` — normalized across all providers.

### Web Fetch (optional — standalone mode)

Fetch a URL and extract clean, readable content for LLM consumption. Only needed when the agent runs standalone.

**Architecture:** Two-tier with automatic escalation.

**Tier 1 — Lightweight (default, handles ~80% of pages):**
- HTTP fetch with timeout and size cap
- Parse HTML with `jsdom`
- Extract article content with `@mozilla/readability`
- Convert to Markdown with `turndown` or `node-html-markdown`
- Fast, low memory, no browser needed

**Tier 2 — Browser fallback (SPAs, JS-heavy pages):**
- If Tier 1 extraction returns empty or too short, retry with Playwright
- Required for: SPAs (React/Vue/Angular), content behind JS rendering, infinite scroll, aggressive bot detection

**Token management:**
- Cap download size (~2-5 MB)
- Cap extracted output (~4-8k characters)
- Truncate at paragraph boundaries
- Return `{ url, title, content (markdown), excerpt, word count, estimated tokens }`

### Browser Automation (Playwright) — always available

Full browser automation for interactive/JS-heavy pages.

**Feasibility confirmed:** Playwright runs headless on WSL2 without a display server. Install Chromium only (~130-280MB).

**WSL2 requirements:**
- `npx playwright install chromium` (or `--with-deps` for system libraries)
- Launch flags: `--disable-gpu`, `--disable-dev-shm-usage`, `--no-sandbox`
- Headless mode works out of the box; headed mode needs WSLg or X server

**Agent tool surface:**
- `navigate(url)` — go to page, wait for network idle
- `click(selector)` — click element
- `type(selector, text)` — fill input
- `press(key)` — keyboard input
- `snapshot()` — compact text/DOM/accessibility snapshot (not full HTML)
- `screenshot()` — capture page as image
- `evaluate(script)` — run JavaScript on page
- `extract()` — run Readability on current page content
- `wait(selector | timeout)` — wait for condition
- `close()` — end session

**Resource model:**
- One long-lived `Browser` process per session, lazy-started on the first browser tool call
- One implicit `BrowserContext` per session (not per tool call, not per turn)
- One active `Page` inside that context
- ~100-300MB RAM per live session — this is why Playwright is escalation, not default

**Browser state persistence:** The `BrowserContext` persists across sequential browser tool calls within the same session. Cookies, localStorage, sessionStorage, and page state survive across `navigate`, `click`, `type`, `press`, `wait`, `snapshot`, `screenshot`, `extract`, and `evaluate` calls. This is essential for multi-step workflows (e.g., navigate to login page, enter credentials, submit, navigate to dashboard — the login session survives).

The model can rely on browser state persisting between tool calls. It cannot rely on state surviving: `close()`, idle timeout expiry, session end, browser crash/restart, or `/undo`/`/restore` operations.

**Browser session lifecycle:**
- **Creation** — lazy, on first browser tool call. No explicit "open" tool needed. Follows the same pattern as LSP servers: start on first use, not at session start
- **Reuse** — all subsequent browser tool calls reuse the same context and page
- **Reset** — `close()` destroys the context and page. The next browser tool call creates a fresh context (clean cookies, clean storage, new page)
- **Cleanup** — context is destroyed on any of: explicit `close()`, session end, idle timeout (1h), hard max lifetime (4h), or browser crash after failed restart. These limits align with the process registry defaults for all spawned processes
- **Crash recovery** — follows capability health tracking: restart once with 2s backoff, then mark unavailable for the session. A browser that crashes twice is genuinely broken

**Page management (v1):** Single active page enforced. If a click opens a popup or new tab, it becomes the active page automatically. No multi-page management tools in v1 — `navigate()` operates on the single active page. Multi-tab support (`list_pages`, `switch_page`) deferred until a concrete need emerges.

**State save/restore:** Not supported in v1. Browser state is ephemeral — it lives only while the context is alive. No cross-close or cross-session cookie persistence. If the model needs to inspect cookies for debugging, it can use `evaluate("document.cookie")`. Serializable state persistence is a potential v2 enhancement.

**Checkpointing interaction:** Browser state is explicitly excluded from the git-based checkpointing system. Browser tool calls carry `externalEffects: true` in undo metadata. On `/undo` or `/restore`, the active browser session is closed to prevent stale state (e.g., cookies referencing server-side sessions that no longer match the restored code state). The agent warns that browser state was not restored and a fresh browser session will be created on next use.

**Process registry integration:** The browser process registers with the shared session process registry (same infrastructure as `open_session` and LSP servers). The registry entry tracks PID, start time, last activity, idle TTL (1h), and hard max (4h). Idle timer resets on every browser tool call.

**Playwright vs Puppeteer:** Playwright is the better fit — stronger locators, auto-waiting, browser-context model. Puppeteer is lighter but only Chromium.

**Snapshot types:**
- **DOM snapshot** — compact accessibility tree / text content. Used for LLM reasoning about page structure
- **Screenshot** — PNG image capture. Used for visual inspection, UI testing, debugging

### Known Risk: Local Execution Security (Malware / Untrusted Content)

Web tools run locally — not in a cloud sandbox. Fetching or rendering untrusted URLs exposes the local environment to malicious content. The risk varies by tool tier:

**Risk by tier:**

| Tool | JS Execution | Malware Vector | Risk Level |
|------|-------------|----------------|------------|
| `web_search` | None (API call) | Prompt injection in snippets | Low |
| `fetch_url` Tier 1 | None (`jsdom` parser, no JS) | Prompt injection in content | Low |
| `fetch_url` Tier 2 | Yes (Playwright renders page) | Browser exploits, drive-by downloads | Medium |
| Browser automation | Yes (full Chromium) | Browser exploits, drive-by downloads, JS eval | Medium-High |

**Mitigations (mandatory for v1 implementation):**

1. **BrowserContext hardening** — All Playwright contexts must be created with:
   - `acceptDownloads: false` — prevent drive-by downloads
   - `javaScriptEnabled: true` (needed for SPAs) but with hardened launch args
   - `permissions: []` — deny geolocation, camera, microphone, notifications
2. **Chromium launch flags** — Beyond the WSL2 flags, add:
   - `--disable-extensions` — no extension loading
   - `--disable-plugins` — no plugin loading (Flash, etc.)
   - `--disable-popup-blocking` is NOT set (popups blocked by default)
   - `--disable-background-networking` — reduce ambient network traffic
   - `--disable-sync` — no Google account sync
3. **Sandbox mode** — On WSL2, `--no-sandbox` is the fallback, but the implementation must:
   - First attempt launch WITH sandbox (`--sandbox`)
   - Fall back to `--no-sandbox` only if sandbox launch fails
   - Log a warning when running without sandbox: "Browser running without OS-level sandbox. Consider configuring user namespaces for stronger isolation."
4. **fetch_url Tier 1 safety** — `jsdom` must NOT enable `runScripts` option (default is disabled). Verify this in implementation and add a test.
5. **Content size enforcement** — Strict caps on download size (5 MB) and extracted content (8K chars), enforced before content reaches the LLM or disk.
6. **Network policy as first gate** — Domain approval (`approved-only` mode) is the primary defense. The agent asks before visiting any unlisted domain.

**Future hardening (post-v1):**
- Run Playwright inside a Docker container with `--network=host` removed and filesystem read-only
- eBPF-based network egress monitoring for the browser process
- Content scanning of fetched HTML for known malware signatures before rendering
- Separate Chromium profile directory per session (prevent cross-session cookie/cache leaks)

### Known Risk: Cloudflare Bot Detection

Headless Chromium gets fingerprinted and blocked by Cloudflare's bot detection (and similar WAFs). This is a known industry-wide problem.

**Potential mitigations (to investigate during implementation):**
- `playwright-extra` with stealth plugin (patches common fingerprint leaks)
- Custom user agent and viewport settings
- Proxy rotation
- Running in headed mode via WSLg when stealth matters

**Status:** Flagged for implementation-time research. Not a foundational decision, but a real operational constraint that will affect reliability.

### Design Principle: Playwright Does NOT Subsume Fetch

Using a full browser for every URL wastes ~100-300MB RAM and is 10x slower than HTTP + Readability. The lightweight tier handles most pages. Playwright is reserved for:
- JavaScript-rendered SPAs
- Interactive automation (login flows, form submission, clicking/pagination)
- Screenshots and visual inspection
- Pages where lightweight extraction fails

### Dependencies

| Package | Size | Purpose |
|---|---|---|
| `jsdom` + `@mozilla/readability` | ~15MB | HTML parsing + article extraction |
| `turndown` or `node-html-markdown` | ~1MB | HTML → Markdown |
| `playwright` (library) | ~8MB | Browser automation API |
| Chromium binary | ~130-280MB | Headless browser (installed separately) |
| Search API client | minimal | HTTP calls to search provider |
