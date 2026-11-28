import assert from "node:assert/strict";
import { test } from "node:test";
import { stripSrcset, stripUrl } from "./urls.ts";

const allow = new Set(["page"]);

test("absolute URLs keep scheme, host and path, the allowed query and no fragment", () => {
  assert.equal(
    stripUrl("https://shop.example/a/b?page=2&email=x%40y#top", allow),
    "https://shop.example/a/b?page=2",
  );
  assert.equal(stripUrl("https://shop.example/a?email=x", allow), "https://shop.example/a");
  assert.equal(stripUrl("HTTP://shop.example/A?page=1&page=2", allow), "http://shop.example/A?page=1&page=2");
});

test("userinfo is removed from the authority", () => {
  assert.equal(stripUrl("https://jane:hunter2@shop.example/a", allow), "https://shop.example/a");
  assert.equal(stripUrl("//jane@cdn.example/a.png?page=1", allow), "//cdn.example/a.png?page=1");
});

test("relative URLs are stripped the same way and stay relative", () => {
  assert.equal(stripUrl("/img/a.png?token=s3cr3t", allow), "/img/a.png");
  assert.equal(stripUrl("b.css?page=1", allow), "b.css?page=1");
  assert.equal(stripUrl("?email=j#x", allow), "");
});

test("only parameter names on the allow list, exactly as written, are kept", () => {
  assert.equal(stripUrl("/a?Page=1&pa%67e=2&page", allow), "/a?page");
  assert.equal(stripUrl("/a?page=1#?email=x", allow), "/a?page=1");
});

test("an in-document reference keeps its fragment, any other fragment is removed", () => {
  assert.equal(stripUrl("#icon-cart", allow), "#icon-cart");
  assert.equal(stripUrl("#access_token=abc&state=x", allow), "");
  assert.equal(stripUrl("/a#icon", allow), "/a");
});

test("data, blob and javascript URLs become empty, so does every scheme but http and https", () => {
  for (const u of [
    "data:image/png;base64,AAAA",
    "blob:https://x/1",
    "javascript:alert(1)",
    " JavaScript:x",
    "java\tscript:alert(1)",
    "\u0001javascript:x",
    "jav\nascript:x",
    "mailto:jane@x.test",
    "tel:+15551234567",
    "file:///home/jane/notes.txt",
    "about:blank",
  ]) {
    assert.equal(stripUrl(u, allow), "", JSON.stringify(u));
  }
  assert.equal(stripUrl("", allow), "");
  assert.equal(stripUrl("   ", allow), "");
});

test("srcset strips each candidate and keeps width, density and height descriptors", () => {
  assert.equal(stripSrcset("/a.png?t=1 1x, /b.png?page=2 2x", allow), "/a.png 1x, /b.png?page=2 2x");
  assert.equal(stripSrcset("/a.png 320w,/b.png   640w", allow), "/a.png 320w, /b.png 640w");
  assert.equal(stripSrcset("/a.png", allow), "/a.png");
});

test("srcset data URLs with commas are dropped whole, never split into a leaking candidate", () => {
  assert.equal(stripSrcset("data:image/png;base64,SECRETPIXELS 1x, /b.png 2x", allow), "/b.png 2x");
  assert.equal(stripSrcset("data:text/plain,Jane%20Doe", allow), "");
});

test("srcset descriptors that are not w, x or h values are dropped", () => {
  assert.equal(stripSrcset("/a.png jane@x.test 2x", allow), "/a.png 2x");
  assert.equal(stripSrcset("/a.png 1.5x, /b.png?token=1 (secret) 2x", allow), "/a.png 1.5x, /b.png 2x");
});

test("an authority whose port is not a number fails closed, so userinfo with / ? or # cannot leak", () => {
  assert.equal(stripUrl("https://jane:hun/ter2@host.example/x", allow), "");
  assert.equal(stripUrl("//jane:hun/ter2@cdn.example/a.png", allow), "");
  assert.equal(stripUrl("https://jane:hun#ter2@host.example/x", allow), "");
  assert.equal(stripUrl("https://host.example:8443/x?page=1", allow), "https://host.example:8443/x?page=1");
  assert.equal(stripUrl("http://[::1]:8080/x", allow), "http://[::1]:8080/x");
  assert.equal(stripUrl("https:///x", allow), "https://x");
  assert.equal(stripUrl("https://", allow), "");
  assert.equal(stripUrl("https://jane@", allow), "");
});

test("path parameters and ;-separated query parameters are stripped", () => {
  assert.equal(
    stripUrl("https://shop.example/cart;jsessionid=A1B2C3?page=1", allow),
    "https://shop.example/cart?page=1",
  );
  assert.equal(stripUrl("/a?page=1;token=SECRET", allow), "/a?page=1");
  assert.equal(stripUrl("/a?token=SECRET;page=2", allow), "/a?page=2");
});

test("a fragment shaped like a token is not an in-document reference", () => {
  assert.equal(stripUrl("#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.sig", allow), "");
  assert.equal(stripUrl(`#${"a".repeat(200)}`, allow), "");
  assert.equal(stripUrl("#:r1:", allow), "#:r1:");
});
