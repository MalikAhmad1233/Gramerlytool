// Runs the grammar rules over ~77,000 sentences of edited text: every hit is a potential false alarm to review.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlapsAny, protectedSpans, ruleIssues } from '../../extension/src/offline/ruleset';
import { cleanSentences } from '../train/confusion';
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
const only = process.argv.slice(2);
const sentences = cleanSentences(DATA);
const hits = new Map<string, string[]>();
let words = 0;
for (const s of sentences) {
  words += s.split(/\s+/).length;
  const prot = protectedSpans(s);
  for (const i of ruleIssues(s, { style: 'neutral', casual: false })) {
    if (overlapsAny(i.start, i.end, prot)) continue;
    if (only.length && !only.includes(i.ruleId)) continue;
    (hits.get(i.ruleId) ?? hits.set(i.ruleId, []).get(i.ruleId)!).push(`“${i.original}”→“${i.replacements[0]}” | ${s.slice(Math.max(0, i.start - 60), i.end + 50)}`);
  }
}
console.log(`${sentences.length} sentences, ${words} words`);
for (const [id, list] of [...hits].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n## ${id}: ${list.length} hits (${((list.length / words) * 100000).toFixed(1)} per 100k words)`);
  for (const l of list.slice(0, 12)) console.log('   ' + l);
}
