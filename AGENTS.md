# AGENTS.md

- Never commit or push unless asked for.
- For custom code we write, prefer self-contained domain classes over floating functions.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` and `Bun.write(...)` for file I/O instead of `node:fs/promises` `readFile` or `writeFile`.
- Keep `./src/agents/instructions.ts`, the README.md "Agent?" section, and this file's instructions block in sync when editing any of them.

<!-- rig:agent-instructions:start -->

## Rig local tools

The `rig` CLI is installed on this machine. It lets agents discover, run, and create local typed tools.

- Run `rig` (or `rig init`) to set up or sync rig. This also updates detected AGENTS.md and CLAUDE.md files with available rig tools.
- Run `rig create <tool>` when the user asks you to turn a repeatable workflow into a reusable tool.
- Run `rig edit <tool>` to print the tool file path for editing.
- Run `rig remove <tool>` to remove a local tool.
- Run `rig cron --help` to schedule and manage tool commands.
- Run `rig typecheck <tool>` to validate a tool's TypeScript and runtime types.
- Run `rig env <tool> KEY=VALUE` to configure tool secrets/settings; run `rig env <tool> remove KEY` to remove them.
- Run `rig list` to discover tools and available `rig run ...` commands.
- Run `rig help <tool>` or `rig help <tool>.<command>` for usage, inputs, and outputs.
- Run `rig run <tool>.<command> [args]` to execute a tool command.
- To chain commands, use `--as <id>`, `--pipe`, and `@id.path` references to pass structured outputs instead of guessing filenames.
- To learn more, run `rig --help` for other Rig CLI commands.

### Available Rig tools

```text
affinity # Drive Affinity through its MCP endpoint.
  rig run affinity.run command=info # Run any Affinity subcommand with typed common options.
  rig run affinity.exec script='console.log('\''ok'\'')' # Execute a JavaScript script against the current Affinity document.
  rig run affinity.exec-file file=script.js # Execute a JavaScript file against the current Affinity document.
  rig run affinity.render spreadIndex=0 sessionUuid=uuid output=/tmp/spread.jpg # Render a spread to a JPEG file.
  rig run affinity.render-selection sessionUuid=uuid output=/tmp/selection.jpg # Render the current selection to a JPEG file.
  rig run affinity.info # Show open documents and their structure.
  rig run affinity.sample-styles # Show paragraph styles in use with fonts and sizes.
  rig run affinity.clear-excess keep=10 # Clear content from all spreads beyond a keep index.
  rig run affinity.content-from-json file=content.json dryRun=true # Build spreads from a JSON content definition.
  rig run affinity.generate-zine title=Voidlight pages=12 output=/tmp/zine_template.json # Generate a JSON zine template.
  rig run affinity.read-doc filename=story.js # Read an SDK documentation topic.
  rig run affinity.list-docs # List available SDK documentation topics.
  rig run affinity.search-hints query=layout # Search community SDK hints.
  rig run affinity.add-hint hint='Use StoryBuilder for text.' # Record an SDK hint for future sessions.
  rig run affinity.list-scripts # List saved scripts in the script library.
  rig run affinity.read-script title='My script' # Read a saved script from the script library.
  rig run affinity.save-script title='My script' description='Does a thing' file=script.js # Save a script to the Affinity script library.

browser # Browser automation using the user's Chrome profile. Wraps agent-browser.
  rig run browser.run args='["get","title"]' # Run any agent-browser command with arbitrary arguments.
  rig run browser.open url=https://example.com # Open a URL in the browser session.
  rig run browser.snapshot interactive=true # Print the accessibility snapshot for the current page.
  rig run browser.get what=title # Read page data such as title, url, text, html, or attributes.
  rig run browser.eval script=document.title json=true # Evaluate JavaScript in the active page.
  rig run browser.screenshot output='~/Downloads/page.png' # Capture a screenshot of the current page.

clean-image-metadata # Strip metadata and provenance chunks from PNG and JPEG files without re-encoding image pixels.
  rig run clean-image-metadata.clean input='~/Downloads/image.png' # Clean metadata from a PNG or JPEG image and write a sanitized copy.

document-editor # Create Notion-style PDF editing review documents as Markdown, HTML, and PDF files.
  rig run document-editor.create documentName='Boundless A5' # Create a dated document editing report using Notion-style old/new text callouts.

enhance-image # Upscale and sharpen images with ESRGAN.
  rig run enhance-image.metadata input=photo.png # Read image dimensions and format through sharp.
  rig run enhance-image.check input=photo.png scale=auto # Load the selected ESRGAN model without writing an output image.
  rig run enhance-image.enhance input=photo.png output=photo_enhanced.png scale=auto height=3000 ppi=300 # Upscale an image and write the enhanced output file.

fetch # Fetch URLs, extract readable text, call JSON APIs, and download files.
  rig run fetch.request url=https://example.com extract=true # Fetch a URL and return the response body or parsed JSON.
  rig run fetch.save url=https://example.com/file.pdf output='~/Downloads/file.pdf' # Fetch a URL and save the response to a local file.

html # Render Markdown or HTML into clean document pages with Tailwind typography and Shiki code highlighting.
  rig run html.render content='# Project brief\n\nHello from Rig.' # Render Markdown or HTML and return the generated document.
  rig run html.write content='# Project brief' output='~/Downloads/project-brief.html' # Render Markdown or HTML and write the generated document to a file.

image # Resize, convert, rotate, encode, inspect, and create placeholders for images.
  rig run image.metadata input=photo.jpg # Read image dimensions and format.
  rig run image.placeholder input=photo.jpg # Generate a ThumbHash data URL placeholder.
  rig run image.encode input=photo.jpg width=400 format=webp kind=dataurl # Transform an image and return a base64 string or data URL.
  rig run image.convert input=photo.jpg width=400 height=400 fit=inside format=webp output=thumb.webp # Transform an image and write it to a file.

isbn-svg # Generate an ISBN barcode as an SVG EAN-13 file.
  rig run isbn-svg.generate isbn='ISBN: 978-1-0697673-3-2' # Validate an ISBN and write an SVG EAN-13 barcode.

pdf # Convert local HTML files or URLs to PDF through Playwright.
  rig run pdf.convert input=page.html output=page.pdf # Convert a local HTML file or URL to a PDF file.

pdf-to-text # Extract UTF-8 text and metadata from PDF files with Poppler.
  rig run pdf-to-text.info input=book.pdf # Read PDF metadata with pdfinfo.
  rig run pdf-to-text.convert input=book.pdf # Convert a PDF to a UTF-8 text file.

socials # Post to Bluesky, Threads, Substack, or Quip through browser automation.
  rig run socials.check # Validate the socials posting script without posting.
  rig run socials.post message=Hello dryRun=true # Post a message and optional images to selected social platforms.

websearch # Search the web with Google via browser automation or DuckDuckGo HTML fetch.
  rig run websearch.search query='Bun runtime' count=5 # Search the web and return structured results.
```

<!-- rig:agent-instructions:end -->
