// Cleaning rule for comment text (the Lab 8 "sanitising" layer).
// Before a comment is saved, <script> and <style> blocks are removed and any other HTML tag is
// stripped, so "<script>alert(1)</script>hi" is saved as "hi".
// This is one layer of several: the website also shows comments with textContent (never innerHTML),
// and the Content-Security-Policy blocks inline scripts.
function cleanText(value) {
  return String(value)
    .replace(/<script[\s\S]*?(<\/script\s*>|$)/gi, '')   // script blocks (also an unclosed one)
    .replace(/<style[\s\S]*?(<\/style\s*>|$)/gi, '')     // style blocks
    .replace(/<\/?[a-z!][^>]*>/gi, '')                   // any other tag: <b>, <img onerror=...>, <!-- -->
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // invisible control characters
    .replace(/\n{3,}/g, '\n\n')                          // at most one empty line in a row
    .trim();
}

module.exports = { cleanText };
