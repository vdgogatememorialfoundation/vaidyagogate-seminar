# Push SeminarSystem to a private GitHub repo (never commits .env)
# Usage:
#   .\scripts\push-to-github.ps1 -RepoName "vaidyagogate-seminar" -GitHubUser "YOUR_GITHUB_USERNAME"

param(
    [Parameter(Mandatory = $true)]
    [string]$RepoName,
    [string]$GitHubUser = $env:GITHUB_USER,
    [switch]$CreateRepo
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git is not installed. Install from https://git-scm.com/download/win then re-run this script." -ForegroundColor Red
    exit 1
}

if (Test-Path ".env") {
    $tracked = git ls-files --error-unmatch .env 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "ERROR: .env is tracked by git. Run: git rm --cached .env" -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path ".git")) {
    git init
    git branch -M main
}

git add -A
git status

$pending = git diff --cached --name-only
if (-not $pending) {
    Write-Host "Nothing to commit."
} else {
    git commit -m "VGMF seminar platform: Vercel, Neon PostgreSQL, Wix subdomains"
}

if ($CreateRepo) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host "Install GitHub CLI: https://cli.github.com/ then run with -CreateRepo" -ForegroundColor Yellow
        exit 1
    }
    if (-not $GitHubUser) {
        $GitHubUser = (gh api user -q .login)
    }
    gh repo create "$GitHubUser/$RepoName" --private --source . --remote origin --push
    Write-Host "Created and pushed to https://github.com/$GitHubUser/$RepoName"
} else {
    if (-not $GitHubUser) {
        Write-Host "Set remote manually: git remote add origin https://github.com/USER/REPO.git"
        Write-Host "Then: git push -u origin main"
        exit 0
    }
    $url = "https://github.com/$GitHubUser/$RepoName.git"
    if (-not (git remote get-url origin 2>$null)) {
        git remote add origin $url
    }
    git push -u origin main
    Write-Host "Pushed to $url"
}

Write-Host ""
Write-Host "Remember: set DATABASE_URL only in Vercel env vars, never commit .env" -ForegroundColor Cyan
