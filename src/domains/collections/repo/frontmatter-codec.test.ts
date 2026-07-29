import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { FrontmatterCodecService, frontmatterCodecLayer } from "./frontmatter-codec";

describe("FrontmatterCodecService", () => {
  it("parses scalar, object, and malformed YAML branches", async () => {
    const parsed = await Effect.runPromise(
      FrontmatterCodecService.use((service) =>
        service.parse(`---
mixed:
  nested: value
  - scalar
items:
  - name: first
    invalid continuation
invalid top-level line
enabled: false
empty: null
single: 'quoted'
---
Body`),
      ).pipe(Effect.provide(frontmatterCodecLayer)),
    );

    expect(parsed).toMatchObject({
      data: {
        mixed: ["scalar"],
        items: [{ name: "first" }],
        enabled: false,
        empty: null,
        single: "quoted",
      },
      body: "Body",
    });
  });
});
