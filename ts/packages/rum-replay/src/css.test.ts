import assert from "node:assert/strict";
import { test } from "node:test";
import { stripCssUrls } from "./css.ts";

const allow = new Set(["page"]);

test('url() arguments are stripped, quoted or not, and written back as url("...")', () => {
  assert.equal(
    stripCssUrls("background:url(/a.png?token=1&page=2)", allow),
    'background:url("/a.png?page=2")',
  );
  assert.equal(
    stripCssUrls("a{background-image:url( 'https://s3.example/u.png?X-Amz-Signature=abc' )}", allow),
    'a{background-image:url("https://s3.example/u.png")}',
  );
  assert.equal(stripCssUrls('b{mask:URL("/m.svg#frag")}', allow), 'b{mask:url("/m.svg")}');
});

test("data URLs in CSS become empty", () => {
  assert.equal(
    stripCssUrls("i{background:url(data:image/png;base64,SECRET)}", allow),
    'i{background:url("")}',
  );
  assert.equal(
    stripCssUrls('@font-face{src:url("data:font/woff2;base64,AAAA") format("woff2")}', allow),
    '@font-face{src:url("") format("woff2")}',
  );
});

test("escapes cannot smuggle a URL past the scrubber", () => {
  assert.equal(stripCssUrls('i{background:url("data\\:image/png,SECRET")}', allow), 'i{background:url("")}');
  assert.equal(stripCssUrls("i{background:\\75 rl(data:image/png,SECRET)}", allow), 'i{background:url("")}');
  assert.equal(stripCssUrls("i{background:u\\72l(/a?token=SECRET)}", allow), 'i{background:url("/a")}');
  assert.equal(stripCssUrls("i{background:url(/a\\?token=SECRET)}", allow), 'i{background:url("/a")}');
});

test("URL strings outside url(), such as @import and image-set, are stripped", () => {
  assert.equal(stripCssUrls('@import "/theme.css?token=SECRET";', allow), '@import "/theme.css";');
  assert.equal(
    stripCssUrls(
      "i{background-image:image-set('/a.png?token=SECRET' 1x, \"data:image/png,SECRET\" 2x)}",
      allow,
    ),
    'i{background-image:image-set("/a.png" 1x, "" 2x)}',
  );
});

test("plain strings, selectors and the rest of the CSS are left as they are", () => {
  const css =
    'a::before{content:"\\201C Hello";font-family:"Helvetica Neue",sans-serif;color:#fff}.x>y{margin:0 auto}';
  assert.equal(stripCssUrls(css, allow), css);
  assert.equal(stripCssUrls("fill:url(#gradient)", allow), 'fill:url("#gradient")');
});

test("comments are removed, since a URL in one is still data", () => {
  assert.equal(stripCssUrls("a{color:red/* https://x.example/?token=SECRET */}", allow), "a{color:red}");
});

test("unterminated input is handled without leaking", () => {
  assert.equal(stripCssUrls("a{background:url(/a?token=SECRET", allow), 'a{background:url("/a")');
  assert.equal(stripCssUrls('a{content:"data:x,SECRET', allow), 'a{content:""');
  assert.equal(stripCssUrls("a{color:red/* SECRET", allow), "a{color:red");
});
