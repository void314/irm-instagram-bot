import { readdirSync, readFileSync, rmSync } from 'fs';

const DST = './dataset';
const files = readdirSync(DST).filter(f => f.endsWith('.md'));

// Kazakh-specific Cyrillic characters
// Note: і/І included — Kazakh uses them extensively; Russian uses them only
// in Roman numerals (І, ІІ, ІІІ) which produce at most 3 matches per file
const KZ_CHARS = /[қңүұөәһіҚҢҮҰӨӘҺІ]/;
const KZ_CHARS_G = /[қңүұөәһіҚҢҮҰӨӘҺІ]/g;

let removed = 0, kept = 0;

for (const f of files) {
  const c = readFileSync(DST + '/' + f, 'utf-8');

  const langMatch = c.match(/\*\*Language:\*\*\s*(.+)$/m);
  const lang = langMatch ? langMatch[1].trim().toLowerCase() : '';
  const isKzFile = f.endsWith('-kz.md');
  const isRuFile = f.endsWith('-ru.md');
  const isDoctor = c.match(/\*\*Type:\*\*\s*doctors/m);

  const titleLine = (c.split('\n')[0] || '').replace(/^#\s*/, '');
  const titleHasKz = KZ_CHARS.test(titleLine);

  const bodyStart = c.indexOf('\n---\n');
  const body = bodyStart > 0 ? c.slice(bodyStart + 5) : c;
  const bodyKzCount = (body.match(KZ_CHARS_G) || []).length;

  let reason = '';

  if (lang === 'kz') {
    reason = 'lang=kz';
  } else if (isKzFile) {
    reason = '-kz.md file';
  } else if (titleHasKz && bodyKzCount > 0 && !isDoctor) {
    // Non-doctor files with KZ in both title and body
    reason = 'KZ title+body';
  } else if (titleHasKz && isDoctor && bodyKzCount > 5) {
    // Doctor with Kazakh content in body (not just name)
    reason = 'doctor with KZ body';
  } else if (bodyKzCount > 50 && !isRuFile && lang !== 'ru' && !isDoctor) {
    // Heavy Kazakh content in body
    reason = 'body has ' + bodyKzCount + ' KZ chars';
  }

  if (reason) {
    rmSync(DST + '/' + f);
    console.log('  REMOVED ' + f + ' (' + reason + ')');
    removed++;
  } else {
    kept++;
  }
}

console.log('\nRemoved: ' + removed + ' / ' + files.length + ' files');
console.log('Remaining: ' + kept);
