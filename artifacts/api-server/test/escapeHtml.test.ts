import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/lib/escapeHtml.ts";

test("escapes all five HTML-significant characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("neutralises a script-injection payload", () => {
  assert.equal(
    escapeHtml(`<script>alert('x')</script>`),
    "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
  );
});

test("neutralises an attribute-breakout payload", () => {
  assert.equal(
    escapeHtml(`" onmouseover="alert(1)`),
    "&quot; onmouseover=&quot;alert(1)",
  );
});

test("escapes ampersand first so entities aren't double-broken", () => {
  assert.equal(escapeHtml("a & b < c"), "a &amp; b &lt; c");
});

test("leaves safe text untouched", () => {
  assert.equal(escapeHtml("Jane Doe 42"), "Jane Doe 42");
  assert.equal(escapeHtml(""), "");
});
