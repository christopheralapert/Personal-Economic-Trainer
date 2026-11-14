param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$containerName = "moneylens-signup-test-" + [guid]::NewGuid().ToString("N")
$testPassword = [guid]::NewGuid().ToString("N")
$previousDatabase = $env:MONEYLENS_TEST_DATABASE_URL
$containerId = $null

Push-Location $repoRoot
try {
    # Only this uniquely named, disposable container is stopped and removed.
    $created = & docker run --detach --rm --name $containerName --publish "127.0.0.1::5432" `
        --env "POSTGRES_PASSWORD=$testPassword" postgres:17.6-alpine
    if ($LASTEXITCODE -ne 0) { throw "Could not start the isolated PostgreSQL container." }
    $containerId = ($created | Select-Object -Last 1).Trim()
    if ($containerId -notmatch '^[0-9a-f]{64}$') { throw "Docker returned an invalid container ID." }
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        & docker exec $containerId pg_isready --username postgres --dbname postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "The isolated PostgreSQL container did not become ready." }
    $published = & docker port $containerId 5432/tcp
    if ($LASTEXITCODE -ne 0 -or $published -notmatch '^127\.0\.0\.1:(\d+)$') {
        throw "Could not resolve the isolated PostgreSQL loopback port."
    }
    $env:MONEYLENS_TEST_DATABASE_URL = "postgresql://postgres:${testPassword}@127.0.0.1:$($Matches[1])/postgres"
    & $Python -m pytest -c backend/api/pyproject.toml `
        tests/api/test_self_signup_settings.py tests/api/test_oidc.py `
        tests/integration/test_self_signup.py tests/integration/test_identity.py `
        tests/integration/test_invited_members.py tests/integration/test_membership_fence.py
    if ($LASTEXITCODE -ne 0) { throw "Identity verification failed; see the pytest result above." }
} finally {
    $env:MONEYLENS_TEST_DATABASE_URL = $previousDatabase
    if ($containerId -match '^[0-9a-f]{64}$') {
        & docker rm --force $containerId *> $null
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove this run's isolated PostgreSQL container: $containerName" }
    }
    Pop-Location
}
