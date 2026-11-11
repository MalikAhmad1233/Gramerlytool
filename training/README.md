# Training WriteMind's built-in checker

The apps work offline with a **built-in checker**: Hunspell dictionaries, a shared rule set
([shared/offline/rules.json](../shared/offline/rules.json)) and a **trained language model**
([shared/model/en.model.txt](../shared/model/en.model.txt)). The same model file is used by the Chrome
extension (`extension/src/offline/model.ts`) and the Windows app (`WriteMind.Core/Offline/LanguageModel.cs`); every
score is an integer, so both make exactly the same choices (194 shared parity cases prove it).

```bash
./training/fetch-data.sh   # download the public datasets (~60 MB) into training/.data
./training/train.sh        # train → shared/model/en.model.txt (about 5 minutes)
./training/eval.sh         # benchmarks → JSON (add -v for every miss on stderr)
```

## What is learned

| Part | Learned from | How |
|------|--------------|-----|
| Vocabulary and word frequencies | Google Books Ngram corpus, via the SymSpell frequency lists (82,765 words) | Each word gets a cost −1000·ln P(word). Words are checked against the American and British Hunspell dictionaries; ~6,700 frequent words the dictionaries lack (ebay, wifi, storyline…) are accepted as correct. |
| Word pairs (context) | Google Books Ngram bigrams via SymSpell (243,342 pairs) | Cost of each word given the previous one. Pruned to 130k pairs: every pair involving a commonly confused word plus the 40,000 most frequent others. |
| Typing-error model | 36,449 real misspellings with their corrections (Wikipedia's list of common misspellings, via codespell) | Each pair is aligned letter by letter; the trainer counts which letters people substitute, drop, add, double and swap (a Kernighan–Church–Gale noisy channel) and turns the counts into edit costs. Suggestions are ranked by edit cost + word frequency + fit with the neighbouring words. |
| Weights | A development split of the misspellings and the JFLEG development set | Grid search for the edit weight, the context weight and the largest correction offered. The test splits are never used for tuning. |
| Confused real words | ~77,000 sentences of edited text (UD EWT, GUM, WikiText-2, public-domain books) | For 56 candidate sets (then/than, form/from, dose/does…), the trainer measures how the word-pair model scores each written word against its alternatives, sets a per-set margin so that false alarms stay under 1 per 150,000 words of correct text, and keeps the sets that still catch at least 20% of swapped words on held-out text (34 sets in the current model). |

## Results (built-in checker, no server)

| Benchmark | Before training | After training |
|-----------|-----------------|----------------|
| Held-out real misspellings (10,731): right word suggested first | 76.0% | **90.3%** |
| … right word in the top 3 | 81.6% | **93.4%** |
| … no suggestion at all | 10.8% | **1.8%** |
| Misspellings inside learner essays (JFLEG, 578): right word first | 57.5% | **75.8%** |
| JFLEG learner essays (1,501 sentences): suggestions that match a human correction | 50.8% | **59.6%** |
| … human corrections found | 20.8% | **25.9%** |
| … suggestions pointing at a real problem (even if the fix differs) | 99.2% | 98.2% |
| Professionally edited sentences (UD PUD, 1,000): notes per 100 sentences | 15.3 | **8.3** (3.7 of them are British spellings flagged in American-English mode) |

JFLEG recall is low for any rule-based checker: most human edits there are rephrasings, missing commas and
articles. The optional WriteMind server (LanguageTool + AI) covers those.

Grammar rules are checked against the same 77,000 edited sentences with `training/eval/rulehits.ts`: every rule
must stay below a few hits per 100,000 words of correct text, and each hit is reviewed by hand.

## Data and licences

Datasets are downloaded for training and evaluation only; none of them is shipped. The shipped model contains
word and word-pair statistics derived from the Google Books Ngram corpus (CC BY 3.0) through SymSpell's frequency
lists (MIT) and integer parameters learned from the other datasets.

| Dataset | Licence | Used for |
|---------|---------|----------|
| SymSpell frequency dictionaries (Wolf Garbe; Google Books Ngram) | MIT; CC BY 3.0 | word and word-pair statistics |
| codespell dictionary (Wikipedia list of common misspellings) | CC BY-SA 3.0 | typing-error model, held-out spelling test |
| Universal Dependencies English EWT, GUM, PUD | CC BY-SA 4.0 | confused-word margins, false-alarm tests |
| WikiText-2 | CC BY-SA 3.0 | confused-word margins |
| big.txt (Project Gutenberg books) | public domain | confused-word margins |
| JFLEG | CC BY-NC-SA 4.0 | evaluation only |
