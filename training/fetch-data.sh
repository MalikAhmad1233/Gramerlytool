#!/usr/bin/env bash
# Downloads the public datasets used to train and evaluate WriteMind's built-in language model into
# training/.data (git-ignored; nothing here is redistributed with the apps). See training/README.md.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .data/jfleg/dev .data/jfleg/test .data/symspell
GH=https://raw.githubusercontent.com
fetch() { [ -s "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; echo "  $2"; }

echo "Word and word-pair statistics (SymSpell, MIT; derived from Google Books Ngram, CC BY 3.0)"
if [ ! -s .data/symspell/symspellpy/frequency_dictionary_en_82_765.txt ]; then
  url=$(curl -fsSL https://pypi.org/pypi/symspellpy/6.10.2/json | python3 -c "import sys,json; print([u['url'] for u in json.load(sys.stdin)['urls'] if u['filename'].endswith('.whl')][0])")
  curl -fsSL -o .data/symspell.whl "$url"
  python3 -c "import zipfile; zipfile.ZipFile('.data/symspell.whl').extractall('.data/symspell')"
  rm .data/symspell.whl
fi

echo "Real misspellings (codespell dictionary, from Wikipedia's list of common misspellings; CC BY-SA 3.0)"
fetch $GH/codespell-project/codespell/main/codespell_lib/data/dictionary.txt .data/codespell.txt

echo "Edited English text (Universal Dependencies EWT, GUM, PUD — CC BY-SA 4.0; WikiText-2 — CC BY-SA 3.0; big.txt — public domain books)"
for f in en_ewt-ud-train en_ewt-ud-dev en_ewt-ud-test; do fetch $GH/UniversalDependencies/UD_English-EWT/master/$f.conllu .data/$f.conllu; done
fetch $GH/UniversalDependencies/UD_English-GUM/master/en_gum-ud-train.conllu .data/en_gum-ud-train.conllu
fetch $GH/UniversalDependencies/UD_English-PUD/master/en_pud-ud-test.conllu .data/en_pud-ud-test.conllu
fetch $GH/pytorch/examples/main/word_language_model/data/wikitext-2/train.txt .data/wikitext-2-train.txt
fetch $GH/norvig/pytudes/main/data/text/big.txt .data/big.txt

echo "Learner essays with human corrections, for evaluation only (JFLEG, CC BY-NC-SA 4.0)"
for split in dev test; do
  for f in src ref0 ref1 ref2 ref3; do fetch $GH/keisks/jfleg/master/$split/$split.$f .data/jfleg/$split/$split.$f; done
done

echo "Held-out split of the misspellings (never seen by the trainer)"
python3 - <<'PY'
import hashlib, re
vocab = {l.split()[0] for l in open('.data/symspell/symspellpy/frequency_dictionary_en_82_765.txt')}
train, held = [], []
for line in open('.data/codespell.txt'):
    line = line.strip()
    if '->' not in line: continue
    typo, right = line.split('->', 1)
    right = right.rstrip(',').strip()
    if ',' in right or not re.fullmatch(r'[a-z]{2,}', typo) or not re.fullmatch(r'[a-z]{2,}', right): continue
    if right not in vocab or typo in vocab: continue
    (held if int(hashlib.md5(typo.encode()).hexdigest(), 16) % 5 == 0 else train).append((typo, right))
import os; os.makedirs('.build', exist_ok=True)
open('.build/spelling-train.tsv', 'w').write(''.join(f'{a}\t{b}\n' for a, b in train))
open('.build/spelling-heldout.tsv', 'w').write(''.join(f'{a}\t{b}\n' for a, b in held))
print(f'  {len(train)} training pairs, {len(held)} held out')
PY
