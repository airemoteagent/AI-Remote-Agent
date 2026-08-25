// Tests for the newer tools: pure functions only (no real launches).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchUrl, validateUrl } from '../src/tools/browser.js';

describe('browser searchUrl', () => {
  it('builds a YouTube search URL', () => {
    assert.equal(
      searchUrl('avicii wake me up', 'youtube'),
      'https://www.youtube.com/results?search_query=avicii%20wake%20me%20up'
    );
  });

  it('builds a Google search URL', () => {
    assert.equal(searchUrl('remote agent', 'google'), 'https://www.google.com/search?q=remote%20agent');
  });

  it('defaults to web search', () => {
    assert.match(searchUrl('test'), /^https:\/\/www\.bing\.com\/search\?q=test$/);
  });

  it('encodes special characters', () => {
    assert.equal(searchUrl('a & b', 'youtube'), 'https://www.youtube.com/results?search_query=a%20%26%20b');
  });
});

describe('browser validateUrl', () => {
  it('accepts https URLs', () => {
    assert.equal(validateUrl('https://example.com/x'), 'https://example.com/x');
  });

  it('accepts http URLs', () => {
    assert.equal(validateUrl('http://example.com'), 'http://example.com/');
  });

  it('rejects non-http(s) schemes', () => {
    assert.equal(validateUrl('file:///etc/passwd'), null);
    assert.equal(validateUrl('javascript:alert(1)'), null);
  });

  it('rejects malformed URLs', () => {
    assert.equal(validateUrl('not a url'), null);
  });
});
