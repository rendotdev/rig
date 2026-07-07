# AGENTS.md

- Never commit or push unless asked for.
- For custom code we write, prefer self-contained domain classes over floating functions.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` and `Bun.write(...)` for file I/O instead of `node:fs/promises` `readFile` or `writeFile`.
- Keep `./src/agents/instructions.ts`, the README.md "Agent?" section, and this file's instructions block in sync when editing any of them.

<!-- rig:agent-instructions:start -->

## Rig local tools

The `rig` CLI is installed on this machine. It is *your* CLI. You own its various tools and commands. Use it to create, edit, and run tools when you need repeatable and determinstic workflows.

- Run `rig` (or `rig init`) to set up or sync rig. This also updates detected AGENTS.md and CLAUDE.md files with available rig tools.
- Run `rig create <tool>` when the user asks you to turn a repeatable workflow into a reusable tool.
- Run `rig edit <tool>` to print the tool file path for editing.
- Run `rig remove <tool>` to remove a local tool.
- Run `rig cron --help` to schedule and manage tool commands.
- Run `rig typecheck <tool>` to validate a tool's TypeScript and runtime types.
- Run `rig env <tool> KEY=VALUE` to configure tool secrets/settings; run `rig env <tool> remove KEY` to remove them.
- Run `rig list` to discover tools and available `rig run ...` commands.
- Run `rig help <topic>` for concept docs (collections, kv, db, env, log, shell, run, tool, args, paths).
- Run `rig help <tool>` or `rig help <tool>.<command>` for usage, inputs, and outputs.
- Run `rig run <tool>.<command> [args]` to execute a tool command.
- To chain commands, use `--as <id>`, `--pipe`, and `@id.path` references to pass structured outputs instead of guessing filenames.
- To learn more, run `rig --help` for other Rig CLI commands.

### Learn more

- Run `rig help collections` to learn about tool content collections (schema-validated markdown document stores with FTS search).
- Run `rig help tool` to learn how to create a new rig tool from scratch.
- Run `rig help kv` to learn about lightweight key-value state.
- Run `rig help db` to learn about raw SQLite databases with migrations.
- Run `rig help topics` to see all available help topics.

### Available Rig tools

```text
artifact # Render markdown/HTML to a styled PDF and publish to Google Drive, or publish JSX/TSX as a live React app on Harbor.
  rig run artifact.publish name=my-report content='# Hello\n\nMarkdown content' # Render markdown or HTML content to a styled PDF and publish to Google Drive. Use --harbor to publish JSX/TSX as a live React app instead.
  rig run artifact.list # List all published artifacts with their URLs and version counts.

braintrust # Query Braintrust traces, experiments, and datasets via toolshed. Uses pay toolshed call -- no token needed.
  rig run braintrust.traces # Preview recent traces for a project.
  rig run braintrust.trace rootSpanId=tsk_abc123 # Get the full span tree for a single trace by root-span-id.
  rig run braintrust.experiments # List experiments for a project.
  rig run braintrust.experiment name=my-experiment # Summarize a single experiment by name.
  rig run braintrust.datasets # List datasets for a project.
  rig run braintrust.dataset name=eval-set # Summarize a single dataset by name.

browser # Headless browser automation on a devbox via pay browser. Supports navigation, DOM interaction, screenshots, video, auth state, and more.
  rig run browser.open devbox=run-console-324 url=https://rpdeshaies-0-xxxx--manage-dashboard-proxy-mydev.dev.stripe.me/dashboard # Open browser at a URL (new session).
  rig run browser.login devbox=run-console-324 url=https://rpdeshaies-0-xxxx--manage-dashboard-proxy-mydev.dev.stripe.me/dashboard # Open browser and log in via 1Password (auto-saves/loads auth state cookies).
  rig run browser.goto devbox=run-console-324 url=https://rpdeshaies-0-xxxx--manage-dashboard-proxy-mydev.dev.stripe.me/dashboard/payments # Navigate to a URL within the current browser session.
  rig run browser.snapshot devbox=run-console-324 # Get accessibility tree snapshot of the current page, optionally scoped to an element ref.
  rig run browser.act devbox=run-console-324 ref=e1 # Snapshot + interact (click or fill) + snapshot in a single SSH call. If text is provided, fills the ref with text; otherwise clicks it.
  rig run browser.wait devbox=run-console-324 text=Today # Poll until the given text appears on the page (up to 30s by default).
  rig run browser.click devbox=run-console-324 ref=e1 # Click an element by ref.
  rig run browser.dblclick devbox=run-console-324 ref=e1 # Double-click an element by ref.
  rig run browser.fill devbox=run-console-324 ref=e2 text=rpdeshaies@stripe.com # Set an input's value by ref (no key events). Use type for typeahead/autocomplete.
  rig run browser.type devbox=run-console-324 text=payment # Type text into the focused element (fires key events, good for typeahead/autocomplete).
  rig run browser.select devbox=run-console-324 ref=e5 value=USD # Pick an option in a <select> element by ref and value.
  rig run browser.check devbox=run-console-324 ref=e7 # Check a checkbox by ref.
  rig run browser.uncheck devbox=run-console-324 ref=e7 # Uncheck a checkbox by ref.
  rig run browser.hover devbox=run-console-324 ref=e3 # Hover over an element by ref.
  rig run browser.press devbox=run-console-324 key=Enter # Press a keyboard key (Enter, Tab, ArrowDown, Escape, etc.).
  rig run browser.drag devbox=run-console-324 refA=e1 refB=e2 # Drag from element refA to element refB.
  rig run browser.reload devbox=run-console-324 # Reload the current page.
  rig run browser.back devbox=run-console-324 # Go back in browser history.
  rig run browser.forward devbox=run-console-324 # Go forward in browser history.
  rig run browser.resize devbox=run-console-324 width=1280 height=800 # Resize the browser viewport.
  rig run browser.screenshot devbox=run-console-324 # Take a screenshot and download it to ~/Downloads/<host>/screenshot-<datetime>.png.
  rig run browser.console devbox=run-console-324 # Print browser console messages. Optionally filter by level (error, warning, log, etc.).
  rig run browser.requests devbox=run-console-324 # List all network requests made since the page loaded.
  rig run browser.request devbox=run-console-324 n=1 # Get full details (headers, body, response) for request N from the network request list.
  rig run browser.eval devbox=run-console-324 js=document.title # Evaluate a JavaScript expression on the current page and return the result.
  rig run browser.locator devbox=run-console-324 ref=e1 # Generate a stable Playwright locator for an element ref.
  rig run browser.state-save devbox=run-console-324 # Save browser auth cookies to ~/.config/tool-browser/<devbox>/auth.json for reuse.
  rig run browser.state-load devbox=run-console-324 # Load saved auth cookies from ~/.config/tool-browser/<devbox>/auth.json.
  rig run browser.video-start devbox=run-console-324 # Start recording a video of the browser session. Optionally provide a name for the recording.
  rig run browser.video-stop devbox=run-console-324 # Stop video recording and download it to ~/Downloads/<host>/video-<datetime>.webm.
  rig run browser.cookies devbox=run-console-324 # List all cookies for the current page.
  rig run browser.localstorage devbox=run-console-324 # List localStorage key-value pairs for the current page.
  rig run browser.close devbox=run-console-324 # Close all browser sessions on the devbox.
  rig run browser.code devbox=run-console-324 code='async (page) => {\n  const rows = page.locator('\''tr[data-row-id]'\'');\n  const cb = (i) => rows.nth(i).locator('\''input[type=checkbox]'\'');\n  await cb(1).click();\n  await cb(4).click({ modifiers: ['\''Shift'\''] });\n  return await rows.nth(4).evaluate((r) => r.getAttribute('\''data-selected'\''));\n}' # Run an arbitrary Playwright snippet against the current page and get a structured result. Pass a function expression invoked with `page`, e.g. `async (page) => { ...; return result; }`. Use for modifier clicks (shift/cmd+click), multi-step DOM reads, and custom waits that the ref-based commands can't express. Provide the snippet inline via `code`, or a local file path via `file`. Returns `ok` (false if the snippet threw), the returned `result`, any `error`, and the page's console error count.
  rig run browser.assert devbox=run-console-324 js='document.querySelectorAll('\''tr[data-row-id]'\'').length === 20' message='table should have 20 rows' # Assert a condition on the page and get a clear pass/fail. `js` is a boolean expression evaluated in the browser (has access to `document`, `window`), e.g. `document.querySelectorAll('tr[data-row-id]').length === 20`. Fails (passed=false) if the expression is falsy or throws. On failure a screenshot is captured and downloaded. This is the core e2e gate: chain it after interactions to verify expected DOM state.
  rig run browser.wait-for devbox=run-console-324 selector='tr[data-row-id]' state=attached # Wait until a CSS selector reaches a state and/or the URL contains a substring, then resolve. States: attached, visible (default), hidden, detached. Use for robust e2e waits (element appears, spinner disappears, navigation completes) instead of fixed sleeps. Returns ok=false on timeout.
  rig run browser.run devbox=run-console-324 cmd='some-subcommand arg1 arg2' # Run any raw pay browser subcommand. Pass the full command string (e.g. 'some-subcommand arg1 arg2').

calendar # Google Calendar CLI via Toolshed MCP. List calendars, list events, create, update, and delete events.
  rig run calendar.calendars # List all available Google Calendars.
  rig run calendar.list # List upcoming calendar events. Defaults to the primary calendar and next 7 days.
  rig run calendar.create title='Team meeting' start=2026-07-01T10:00:00 end=2026-07-01T11:00:00 description='Quarterly planning' # Create a new calendar event.
  rig run calendar.update eventId=abc123 title='Updated meeting title' # Update an existing calendar event by event ID.
  rig run calendar.delete eventId=abc123 # Delete a calendar event by event ID.

ci # Full PR + CI status as structured JSON (per-check state, rollup, reviews).
  rig run ci.status pr=2254689 # Get CI check status, rollup, and review state for a PR.

console-trace # Analyze Console agent traces from Braintrust. Detects chart/data issues, slow responses, and agent misbehavior.
  rig run console-trace.trace taskId=tsk_abc123 # Analyze a specific trace by task ID.
  rig run console-trace.recent hours=24 # Analyze recent traces from the past N hours (default 24). Only shows turns with detected issues.

devbox # Manage Stripe remote devboxes: list, provision, SSH, tunnel, flags, browser automation, and more.
  rig run devbox.list # List all devboxes with status, branch, and go link.
  rig run devbox.ssh name=run-console-324 # SSH into a devbox, optionally running a remote command.
  rig run devbox.delete name=run-console-306 # Delete a devbox entirely.
  rig run devbox.url name=run-console-324 # Get the go link / dashboard URL for a devbox.
  rig run devbox.run box=run-console-324 command='pay status' # Run a command on a devbox via pay exec.
  rig run devbox.provision name=console-324 # Full spin-up: create devbox, sync config/skills, start services, open Chrome, enable feature flags.
  rig run devbox.rebase name=run-console-324 # Rebase the devbox on latest master, clear Vite cache, and restart services. Fixes stale bundle 404s.
  rig run devbox.tunnel name=run-console-324 # Start a persistent SSH ControlMaster tunnel for a devbox (~20ms/cmd vs ~1.2s).
  rig run devbox.tunnel-stop name=run-console-324 # Stop the persistent SSH ControlMaster tunnel for a devbox.
  rig run devbox.tunnel-status name=run-console-324 # Check whether the persistent SSH tunnel for a devbox is active.
  rig run devbox.flags list=true # Manage default feature flags for devboxes. Without --add or --remove, enables all default flags on the named devbox. Use --list to show defaults without enabling.
  rig run devbox.rebuild name=run-console-324 pkg=dashboard/my-package # Rebuild an extracted frontend package on the devbox: prettier check, type check, unit tests, build dist, clear Vite cache, restart Vite.
  rig run devbox.browser name=run-console-324 args=screenshot # Run browser automation on a devbox via tool-browser.ts (pay browser). Pass subcommand and args as a single space-separated string, e.g. "open https://...", "screenshot", "login https://...". Screenshots/videos auto-download to ~/Downloads.

gdrive # Google Drive CLI via Toolshed MCP. Search, get, list, name, and comment on files.
  rig run gdrive.search query='console design' limit=20 # Search Google Drive files by query string.
  rig run gdrive.get fileId=1aBcDeFgHiJkLmNoPqRsTuVwXyZ # Get full content of a Google Drive file by ID.
  rig run gdrive.list folderId=root # List files in a Google Drive folder. Defaults to root.
  rig run gdrive.name fileId=1aBcDeFgHiJkLmNoPqRsTuVwXyZ # Get the name of a Google Drive file by ID.
  rig run gdrive.comments fileId=1aBcDeFgHiJkLmNoPqRsTuVwXyZ # Get all comments on a Google Drive file by ID.

gmail # Gmail CLI via Toolshed MCP (pay toolshed call).
  rig run gmail.search query='is:unread in:inbox' limit=20 # Search Gmail messages by query.
  rig run gmail.get messageId=18a1b2c3d4e5f678 # Get a Gmail message by ID.
  rig run gmail.thread threadId=18a1b2c3d4e5f678 # Get a Gmail thread by ID.
  rig run gmail.labels # List all Gmail labels.
  rig run gmail.archive messageId=18a1b2c3d4e5f678 # Archive a Gmail message by ID.
  rig run gmail.star messageId=18a1b2c3d4e5f678 # Star a Gmail message by ID.
  rig run gmail.mark-read messageId=18a1b2c3d4e5f678 # Mark a Gmail message as read.
  rig run gmail.mark-unread messageId=18a1b2c3d4e5f678 # Mark a Gmail message as unread.

gtasks # Manage Google Tasks via Toolshed MCP.
  rig run gtasks.lists # List all Google Task lists.
  rig run gtasks.list # List tasks in a task list.
  rig run gtasks.get taskId=abc123 # Get a specific task by ID.
  rig run gtasks.create title='Buy groceries' # Create a new task.
  rig run gtasks.complete taskId=abc123 # Mark a task as completed.

jira # Get, update, comment, transition, search, and create Stripe Jira tickets via REST API.
  rig run jira.get key=CONSOLE-123 full=false # Get a Jira ticket's details.
  rig run jira.create project=CONSOLE type=Story summary='Add pagination to payments list' # Create a new Jira ticket in a project.
  rig run jira.update key=CONSOLE-123 summary='New title' priority=High # Update fields on an existing Jira ticket (summary, description, assignee, priority).
  rig run jira.comment key=CONSOLE-123 text='Investigated and found root cause in payments module.' # Add a comment to a Jira ticket.
  rig run jira.comments key=CONSOLE-123 # List all comments on a Jira ticket (with IDs for editing or deleting).
  rig run jira.edit-comment key=CONSOLE-123 commentId=10001 text='Updated investigation notes.' # Edit an existing comment by ID.
  rig run jira.delete-comment key=CONSOLE-123 commentId=10001 # Delete a comment by ID.
  rig run jira.transition key=RUN_CONSOLE-321 status='In Progress' # Transition a ticket to a new status by name. Use the transitions command first if unsure of valid status names.
  rig run jira.transitions key=CONSOLE-123 # List all available transitions (valid status names) for a ticket. Use this before calling transition if unsure.
  rig run jira.search jql='project = CONSOLE AND assignee = rpdeshaies AND statusCategory != Done' # Search Jira using JQL. Pass the full JQL query as a single string.
  rig run jira.priorities key=CONSOLE-123 # List valid priority values for a ticket's project.

notes # Personal knowledge base: vault (references), tracker (Jira/devbox tracker), and worklogs (daily activity). [collections: vault, tracker, worklogs]
  rig run notes.vault-save id=hitl-modal-bug source_type=slack captured=2026-07-02 body='## Summary\nBug details...' # Save a reference note to the vault.
  rig run notes.vault-get id=hitl-modal-bug # Get a vault note by ID.
  rig run notes.vault-search query=hitl limit=5 # Full-text search across vault notes.
  rig run notes.vault-list # List all vault notes.
  rig run notes.vault-remove id=old-note # Remove a vault note by ID.
  rig run notes.tracker-get key=CONSOLE-141 # Get a tracker note by ticket key (e.g. CONSOLE-141).
  rig run notes.tracker-save ticket=CONSOLE-141 summary='Pin conversations' url=https://jira.corp.stripe.com/browse/CONSOLE-141 jira_status='On Track' devbox=console-141 devbox_url=https://go/devbox/run-console-141 # Create or update a tracker note.
  rig run notes.tracker-update key=CONSOLE-141 jira_status=Done # Update specific fields on a tracker entry (merge, not overwrite).
  rig run notes.tracker-list # List all tracked items.
  rig run notes.tracker-search query=pin limit=5 # Full-text search across tracker notes.
  rig run notes.log-append entry='## 14:00 - Fixed a bug\n- Details' # Append an entry to today's (or a specific date's) work log.
  rig run notes.log-get date=2026-06-30 # Read a work log for a specific date.
  rig run notes.log-list # List available work log dates.
  rig run notes.log-search query=codex limit=5 # Full-text search across work logs.

pdf # Convert markdown (or HTML) to a styled PDF using Puppeteer and Google Chrome.
  rig run pdf.convert markdown='# Hello\n\nThis is **markdown**.' # Convert markdown content to a PDF. Provide content as an inline string via --markdown, a file path via --input, or pipe via stdin. Output defaults to ~/Downloads/document-<timestamp>.pdf.

pr # Stripe GHE pull request tool. Get PR details, list open PRs, check CI status, post reviews, approve, request changes, or request re-review.
  rig run pr.get prNum=2254689 # Get details for a pull request by number.
  rig run pr.list # List open pull requests for an author.
  rig run pr.ci prNum=2254689 # Show CI check status for a pull request.
  rig run pr.review prNum=2254689 payload='{"comments":[{"path":"pay-server/manage/frontend/src/foo.tsx","line":42,"body":"question: could this be simplified?"}]}' # Post inline review comments on a PR. Pass the review payload as a JSON string with shape: { "comments": [{ "path": "...", "line": N, "body": "..." }], "body": "" }.
  rig run pr.approve prNum=2254689 message=lgtm # Approve a pull request, optionally with a message.
  rig run pr.request-changes prNum=2254689 message='please fix the type error on line 42' # Request changes on a pull request with a required message.
  rig run pr.request-review prNum=2254689 reviewers=hashraf,williamlu # Post an 'r? @reviewer' comment to reassign review. Pass reviewers as a comma-separated string (e.g. "hashraf,williamlu"). If omitted, re-pings everyone who has previously reviewed.

search # Stripe internal search and Trailhead docs via toolshed. Uses pay toolshed call — no token needed.
  rig run search.query query='payment intents webhook retries' limit=10 # Search Stripe-internal content (docs, code, go links).
  rig run search.trailhead idOrUrl=https://trailhead.stripe.com/docs/some-doc # Fetch a Trailhead doc by URL or ID.
  rig run search.space idOrUrl=https://trailhead.stripe.com/spaces/console # Fetch a Trailhead space by URL or ID, listing all docs within it.

sentry # Query Sentry issues, events, and tags via toolshed. Uses pay toolshed call — no token needed.
  rig run sentry.projects # List Sentry projects for known teams (or a specific team).
  rig run sentry.issues project=console # List issues for a Sentry project slug.
  rig run sentry.issue id=123456789 # Get details and additional data for a single Sentry issue.
  rig run sentry.events id=123456789 # List recent events for a Sentry issue.
  rig run sentry.tags id=123456789 # Get tag breakdown for a Sentry issue.

slack # Fetch Stripe Slack threads, channel history, mentions, and search messages via toolshed. No SLACK_TOKEN needed -- uses pay toolshed call which authenticates via certproxy. Private channels require Slack OAuth at go/toolshed-oauth.
  rig run slack.get url=https://stripe.slack.com/archives/C01AB2CD3EF/p1234567890123456 # Fetch and display a Slack thread by URL.
  rig run slack.channels # Fetch recent message history for Slack channels. Defaults to the four console team channels if none are specified.
  rig run slack.mentions # Fetch DMs and @rpdeshaies mentions from the last N hours.
  rig run slack.search query='console list page migration' # Search Slack messages. Multi-word queries should be passed as a single quoted string.

sourcegraph # Search and read Stripe codebases via Sourcegraph toolshed. Uses pay toolshed call — no token needed.
  rig run sourcegraph.search query=handlePaymentIntent # Keyword search across Stripe codebases.
  rig run sourcegraph.nls query='payment retry logic' # Semantic / NLS (natural language) search across Stripe codebases.
  rig run sourcegraph.def symbol=usePaymentForm # Find symbol definitions in a codebase.
  rig run sourcegraph.read repo=stripe-internal/mint path=pay-server/manage/frontend/src/index.tsx # Read a file from a Sourcegraph-indexed repo, optionally scoped to a line range.
  rig run sourcegraph.ls repo=stripe-internal/mint # List files and directories in a repo path.

standup # Render a standup PDF report from a JSON data payload.
  rig run standup.render data='{"date":"2026-06-30","readAloud":["Shipped X","Working on Y"],"done":[{"id":"RUN_CONSOLE-332","bluf":"Fixed the bug.","status":"Merged","statusColor":"green","links":[]}]}' # Render a standup PDF from JSON data. Pass JSON via --data inline or --input as a file path.

statusline # Render the Claude Code statusline. Reads session context from JSON (stdin or --input), outputs an ANSI-colored terminal display showing session info, PRs, Jira tickets, agenda, and LMS requests.
  rig run statusline.render json='{"cwd":"/Users/rpdeshaies/stripe/mymind","model":{"display_name":"Claude Sonnet 4.6"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":0.12,"total_duration_ms":45000}}' # Render the statusline from a JSON input string (the StatusLineInput payload).

statusline-refresh-agenda # Fetch today's Google Calendar events via Toolshed and write them to a cache file for the statusline.
  rig run statusline-refresh-agenda.refresh # Fetch upcoming calendar events for today and write them to the agenda cache file.

statusline-refresh-gh # Background cache refresh for PRs and Jira tickets used by the statusline. Fetches open PRs, review-requested PRs, Jira tickets, and LMS requests, then writes the result to a cache file.
  rig run statusline-refresh-gh.run # Fetch PRs, review requests, Jira tickets, and LMS requests, then write the result to a cache file.

webpage # Fetch a webpage and return clean markdown, raw HTML, or a CSS-selector-scoped excerpt.
  rig run webpage.fetch url=https://example.com # Fetch a webpage and convert it to readable markdown using Readability and Turndown.

websearch # Search the web via DuckDuckGo and return results as markdown.
  rig run websearch.search query='bun javascript runtime' limit=8 fetch=false # Search the web and return top results as markdown. Use --fetch to also fetch and summarize the first result.
```

<!-- rig:agent-instructions:end -->
