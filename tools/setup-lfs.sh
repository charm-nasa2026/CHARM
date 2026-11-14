#!/usr/bin/env bash
# Set up Git LFS for the raw team data and copy the files in.
#   bash tools/setup-lfs.sh "<path to charm_db folder>" ["<path to Final data folder>"]
# WSL example:
#   bash tools/setup-lfs.sh "/mnt/c/Users/yarin/Desktop/NASA SpaceApp 2026/14_11_2026/charm_db/charm_db" \
#                           "/mnt/c/Users/yarin/Desktop/NASA SpaceApp 2026/14_11_2026/Final data"
# It stages the files but does not commit or push.
set -euo pipefail
DB="${1:?give the path to the charm_db folder (the one that contains observations.csv)}"
FINAL="${2:-}"
cd "$(git rev-parse --show-toplevel)"

if ! git lfs version >/dev/null 2>&1; then
  echo "Git LFS is not installed. WSL/Ubuntu: sudo apt-get install -y git-lfs   macOS: brew install git-lfs   Windows: included in Git for Windows"
  exit 1
fi
git lfs install

# .gitattributes must be in place before the large files are added
grep -q "data/raw/\*\* filter=lfs" .gitattributes 2>/dev/null || {
  printf '%s\n' '# Git LFS: the team'"'"'s raw data files (large). Everything else in the repo is normal git.' \
    'data/raw/** filter=lfs diff=lfs merge=lfs -text' \
    '# keep the README in data/raw as a normal text file' \
    'data/raw/README.md !filter !diff !merge text' >> .gitattributes; }
git add .gitattributes

[ -f "$DB/observations.csv" ] || { echo "observations.csv not found in: $DB"; exit 1; }
mkdir -p data/raw/charm_db
for f in observations.csv daily_panel.csv context_timeseries.csv derived_features.csv personal_baselines.csv reference_ranges.csv \
         participants.csv parameters.csv population_stats.csv README.txt CHARM_Unified.xlsx; do
  [ -f "$DB/$f" ] && cp "$DB/$f" data/raw/charm_db/ && echo "copied charm_db/$f"
done
if [ -n "$FINAL" ]; then
  mkdir -p data/raw/final_data
  [ -f "$FINAL/Health_Observations_By_Participant_and_Parameter (1).xlsx" ] && \
    cp "$FINAL/Health_Observations_By_Participant_and_Parameter (1).xlsx" data/raw/final_data/Health_Observations_By_Participant_and_Parameter.xlsx && echo "copied final_data/Health_Observations…xlsx"
  for f in charm_reference_ranges.csv charm_reference_ranges.xlsx; do
    [ -f "$FINAL/$f" ] && cp "$FINAL/$f" data/raw/final_data/ && echo "copied final_data/$f"
  done
fi

git add data/raw
echo
echo "Files that will go to LFS (should list every file in data/raw except README.md):"
git lfs ls-files
echo
echo "Check, then: git commit -m \"Add raw team data (Git LFS)\" && git push"
