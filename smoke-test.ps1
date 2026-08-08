# smoke-test.ps1

$base = 'http://localhost:3000'

Write-Host ""
Write-Host "=== 1. Issue a FREE key (sliding-window) ===" -ForegroundColor Cyan
$issued = Invoke-RestMethod -Method Post -Uri "$base/keys" `
          -ContentType 'application/json' `
          -Body '{"tier":"free","algorithm":"sliding-window"}'
$issued | ConvertTo-Json
$freeKey = $issued.key

Write-Host ""
Write-Host "=== 2. Issue a PRO key (token-bucket) ===" -ForegroundColor Cyan
$pro = Invoke-RestMethod -Method Post -Uri "$base/keys" `
       -ContentType 'application/json' `
       -Body '{"tier":"pro","algorithm":"token-bucket"}'
$pro | ConvertTo-Json
$proKey = $pro.key

Write-Host ""
Write-Host "=== 3. GET /keys/tiers ===" -ForegroundColor Cyan
Invoke-RestMethod -Uri "$base/keys/tiers" | ConvertTo-Json -Depth 5

Write-Host ""
Write-Host "=== 4. GET /api/ping with valid free key (expect 200) ===" -ForegroundColor Cyan
$r = Invoke-WebRequest -Uri "$base/api/ping" -Headers @{'X-API-Key' = $freeKey}
Write-Host "HTTP $($r.StatusCode)"
Write-Host "X-RateLimit-Limit:     $($r.Headers['X-RateLimit-Limit'])"
Write-Host "X-RateLimit-Remaining: $($r.Headers['X-RateLimit-Remaining'])"
Write-Host "X-RateLimit-Algorithm: $($r.Headers['X-RateLimit-Algorithm'])"
$r.Content

Write-Host ""
Write-Host "=== 5. GET /api/ping with NO key (expect 401) ===" -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "$base/api/ping"
} catch {
    $resp = $_.Exception.Response
    Write-Host "HTTP $([int]$resp.StatusCode) - correct"
}

Write-Host ""
Write-Host "=== 6. GET /api/ping with INVALID key (expect 401) ===" -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "$base/api/ping" -Headers @{'X-API-Key' = 'sk_fakekeyhere'}
} catch {
    $resp = $_.Exception.Response
    Write-Host "HTTP $([int]$resp.StatusCode) - correct"
}

Write-Host ""
Write-Host "=== 7. GET /api/data with pro key ===" -ForegroundColor Cyan
$d = Invoke-WebRequest -Uri "$base/api/data" -Headers @{'X-API-Key' = $proKey}
Write-Host "HTTP $($d.StatusCode)"
$d.Content

Write-Host ""
Write-Host "=== 8. Exhaust the FREE key (limit=60, send 62 requests) ===" -ForegroundColor Cyan
$allowed = 0
$denied = 0
for ($i = 1; $i -le 62; $i++) {
    try {
        $x = Invoke-WebRequest -Uri "$base/api/ping" -Headers @{'X-API-Key' = $freeKey}
        $allowed++
    } catch {
        $denied++
        if ($denied -eq 1) {
            $errResp = $_.Exception.Response
            $statusCode = [int]$errResp.StatusCode
            Write-Host "  First 429 at request number $i - HTTP $statusCode"
            try {
                $ra = $errResp.Headers.GetValues('Retry-After') | Select-Object -First 1
                Write-Host "  Retry-After: $ra seconds"
            } catch {
                Write-Host "  (Retry-After header not readable from exception)"
            }
        }
    }
}
Write-Host "  Allowed: $allowed"
Write-Host "  Denied:  $denied"

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
