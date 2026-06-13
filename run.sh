#!/bin/zsh
# tv-price-watcher: スクレイプ → 変更があれば commit & push (GitHub Pages 自動反映)
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
unset GITHUB_TOKEN  # 無効な古いトークンが credential helper を妨害するため
LOG="logs/run-$(date +%Y%m%d).log"
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="
  node scrape.mjs
  if ! git diff --quiet docs/data.json; then
    git add docs/data.json
    git commit -m "data: $(date '+%Y-%m-%d %H:%M')" --quiet
    git push --quiet origin main && echo "pushed"
  else
    echo "no change"
  fi
} >> "$LOG" 2>&1
