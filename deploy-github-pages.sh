#!/usr/bin/env bash
set -euo pipefail

BRANCH="${1:-main}"
REMOTE="${2:-origin}"

if [[ ! -d .git ]]; then
  echo "Запускайте скрипт из корня git-репозитория." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Есть незакоммиченные изменения. Сначала выполните git add и git commit." >&2
  exit 1
fi

git checkout "$BRANCH"
git push "$REMOTE" "$BRANCH"

echo "Push выполнен. Workflow .github/workflows/deploy-pages.yml автоматически публикует сайт в GitHub Pages."
echo "В Settings -> Pages источником должен быть выбран GitHub Actions."
