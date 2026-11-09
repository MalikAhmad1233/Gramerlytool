#!/usr/bin/env bash
# Downloads LanguageTool server + language modules from Maven Central into
# infra/languagetool/lib. Requires Maven (mvn) and Java 17+.
set -euo pipefail
cd "$(dirname "$0")/../infra/languagetool"
mvn -q -B package
echo "LanguageTool jars: $(ls lib | wc -l) in $(pwd)/lib"
