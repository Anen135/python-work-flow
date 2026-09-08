param(
    [string]$Branch = "main",
    [string]$Remote = "origin"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".git")) {
    throw "Запускайте скрипт из корня git-репозитория."
}

if (git status --porcelain) {
    throw "Есть незакоммиченные изменения. Сначала выполните git add и git commit."
}

git checkout $Branch
git push $Remote $Branch

Write-Host "Push выполнен. Workflow .github/workflows/deploy-pages.yml автоматически публикует сайт в GitHub Pages."
Write-Host "В Settings -> Pages источником должен быть выбран GitHub Actions."
