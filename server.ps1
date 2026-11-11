param([switch]$OpenBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$address = 'http://127.0.0.1:8765'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'TourExam'
$dataFile = Join-Path $dataDirectory 'wrong-questions.json'
$progressFile = Join-Path $dataDirectory 'paper-progress.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("$address/")

function Send-Response($context, [int]$status, [string]$type, [byte[]]$bytes) {
    $context.Response.StatusCode = $status
    $context.Response.ContentType = $type
    $context.Response.Headers['Cache-Control'] = 'no-store'
    $context.Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.Close()
}

function Send-Json($context, [int]$status, $value) {
    $json = ConvertTo-Json -InputObject $value -Depth 40 -Compress
    Send-Response $context $status 'application/json; charset=utf-8' $utf8.GetBytes($json)
}

function Read-Wrong {
    if (-not (Test-Path -LiteralPath $dataFile)) { return }
    $content = [IO.File]::ReadAllText($dataFile, $utf8)
    $parsed = ConvertFrom-Json -InputObject $content
    if (-not ($parsed.items -is [array])) { throw 'Wrong-question data file has an invalid format.' }
    return @($parsed.items)
}

function Test-AnswerMap($answers) {
    if ($answers -isnot [pscustomobject]) { return $false }
    foreach ($property in $answers.PSObject.Properties) {
        if ($property.Value -isnot [array]) { return $false }
        foreach ($letter in $property.Value) {
            if ($letter -isnot [string]) { return $false }
        }
    }
    return $true
}

function Test-Attempt($attempt) {
    return ($attempt -and $attempt.id -is [string] -and -not [string]::IsNullOrWhiteSpace($attempt.id) -and
        $attempt.submittedAt -is [string] -and $attempt.submittedAt -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -and
        (Test-AnswerMap $attempt.answers))
}

function Write-Data($file, $value) {
    if (-not (Test-Path -LiteralPath $dataDirectory)) {
        New-Item -ItemType Directory -Path $dataDirectory | Out-Null
    }
    $json = ConvertTo-Json -InputObject $value -Depth 40 -Compress
    $temporary = Join-Path $dataDirectory ([IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($temporary, $json, $utf8)
        if (Test-Path -LiteralPath $file) {
            [IO.File]::Replace($temporary, $file, "$file.bak")
        } else {
            [IO.File]::Move($temporary, $file)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

function Read-Progress {
    if (-not (Test-Path -LiteralPath $progressFile)) { return }
    $parsed = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($progressFile, $utf8))
    if (-not ($parsed.items -is [array])) { throw 'Paper progress data file has an invalid format.' }
    return @($parsed.items)
}

try {
    $listener.Start()
    Write-Host "Exam server: $address/"
    Write-Host "Keep this window open. Press Ctrl+C to stop."
    if ($OpenBrowser) { Start-Process "$address/" }
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $request = $context.Request
            if ($request.Headers['Host'] -ne '127.0.0.1:8765') {
                Send-Json $context 403 @{ error = 'Invalid host.' }
                continue
            }
            $path = $request.Url.AbsolutePath
            if ($path -eq '/api/wrong' -and $request.HttpMethod -eq 'GET') {
                Send-Json $context 200 @{ items = @(Read-Wrong) }
            } elseif ($path -eq '/api/progress' -and $request.HttpMethod -eq 'GET') {
                Send-Json $context 200 @{ items = @(Read-Progress) }
            } elseif (($path -eq '/api/wrong/add' -or $path -eq '/api/wrong/remove' -or $path -eq '/api/progress/save' -or $path -eq '/api/progress/submit' -or $path -eq '/api/progress/import') -and $request.HttpMethod -eq 'POST') {
                if ($request.Headers['Origin'] -ne $address -or $request.ContentType -notmatch '^application/json(?:;|$)' -or $request.ContentLength64 -lt 0 -or $request.ContentLength64 -gt 5242880) {
                    Send-Json $context 403 @{ error = 'Invalid request origin or content.' }
                    continue
                }
                $reader = New-Object IO.StreamReader($request.InputStream, $utf8)
                try { $body = ConvertFrom-Json -InputObject $reader.ReadToEnd() } finally { $reader.Dispose() }
                if ($path.StartsWith('/api/progress/')) {
                    if (-not ($body.paperId -is [string]) -or [string]::IsNullOrWhiteSpace($body.paperId) -or
                        $body.paperId.Length -gt 200 -or $body.revision -isnot [int] -or $body.revision -lt 0) {
                        throw 'Invalid paper progress request.'
                    }
                    $entries = @(Read-Progress)
                    $existing = @($entries | Where-Object { $_.paperId -ceq $body.paperId })
                    if ($existing.Count -gt 1) { throw 'Duplicate paper progress records.' }
                    $revision = if ($existing.Count) { $existing[0].revision } else { 0 }
                    if ($revision -ne $body.revision) {
                        Send-Json $context 409 @{ error = 'Progress changed in another browser.'; items = $entries }
                        continue
                    }
                    $count = if ($existing.Count) { $existing[0].count } else { 0 }
                    $session = $body.session
                    $attempts = @()
                    if ($existing.Count -and $existing[0].attempts -is [array]) { $attempts = @($existing[0].attempts) }
                    if ($path -eq '/api/progress/submit') {
                        if (-not $existing.Count -or -not $existing[0].session -or $existing[0].session.id -cne $body.sessionId) {
                            Send-Json $context 409 @{ error = 'The current practice has changed.'; items = $entries }
                            continue
                        }
                        if (-not (Test-Attempt $body.attempt) -or $body.attempt.id -cne $body.sessionId) {
                            throw 'Invalid submitted answer sheet.'
                        }
                        $attempts = @($attempts) + @($body.attempt)
                        $count++
                        $session = $null
                    } else {
                        if ($path -eq '/api/progress/import') {
                            if ($existing.Count) {
                                Send-Json $context 409 @{ error = 'Progress already exists for this paper.'; items = $entries }
                                continue
                            }
                            if ($body.count -isnot [int] -or $body.count -lt 0) { throw 'Invalid practice count.' }
                            if ($body.attempts -isnot [array]) {
                                throw 'Invalid imported answer sheets.'
                            }
                            foreach ($importedAttempt in $body.attempts) {
                                if (-not (Test-Attempt $importedAttempt)) { throw 'Invalid imported answer sheet.' }
                            }
                            $count = $body.count
                            $attempts = @($body.attempts)
                        }
                        if (($path -ne '/api/progress/import' -or $null -ne $session) -and
                            (-not $session -or $session.id -isnot [string] -or [string]::IsNullOrWhiteSpace($session.id) -or
                            $session.index -isnot [int] -or $session.index -lt 0 -or $session.answers -isnot [pscustomobject])) {
                            throw 'Invalid practice session.'
                        }
                    }
                    $entry = @{ paperId = $body.paperId; revision = $revision + 1; count = $count; session = $session; attempts = $attempts }
                    $entries = @($entries | Where-Object { $_.paperId -cne $body.paperId }) + @($entry)
                    Write-Data $progressFile @{ items = $entries }
                    Send-Json $context 200 @{ items = $entries }
                    continue
                }
                $items = @(Read-Wrong)
                if ($path -eq '/api/wrong/add') {
                    if (-not ($body.items -is [array])) { throw 'Expected an array of questions.' }
                    $known = @{}
                    foreach ($item in $items) { $known[$item.question.id] = $true }
                    foreach ($item in $body.items) {
                        if (-not ($item.question.id -is [string]) -or [string]::IsNullOrWhiteSpace($item.question.id) -or
                            -not ($item.question.stem -is [string]) -or -not ($item.question.options -is [array]) -or
                            -not ($item.question.answer -is [array]) -or -not ($item.paperName -is [string])) {
                            throw 'Invalid wrong-question item.'
                        }
                        if (-not $known.ContainsKey($item.question.id)) {
                            $items += $item
                            $known[$item.question.id] = $true
                        }
                    }
                } else {
                    if (-not ($body.id -is [string]) -or [string]::IsNullOrWhiteSpace($body.id)) { throw 'Invalid question ID.' }
                    $items = @($items | Where-Object { $_.question.id -ne $body.id })
                }
                Write-Data $dataFile @{ items = @($items) }
                Send-Json $context 200 @{ items = @($items) }
            } elseif ($request.HttpMethod -eq 'GET') {
                $staticFiles = @{
                    '/' = 'index.html'; '/index.html' = 'index.html'; '/app.js' = 'app.js'
                    '/style.css' = 'style.css'; '/review.css' = 'review.css'; '/bundled-papers.js' = 'bundled-papers.js'
                    '/vendor/pdf.min.js' = 'vendor\pdf.min.js'
                    '/vendor/pdf.worker.min.js' = 'vendor\pdf.worker.min.js'
                    '/vendor/jszip.min.js' = 'vendor\jszip.min.js'
                }
                if (-not $staticFiles.ContainsKey($path)) {
                    Send-Json $context 404 @{ error = 'Not found.' }
                    continue
                }
                $file = Join-Path $root $staticFiles[$path]
                $type = if ($path -eq '/' -or $path.EndsWith('.html')) { 'text/html; charset=utf-8' } elseif ($path.EndsWith('.css')) { 'text/css; charset=utf-8' } else { 'text/javascript; charset=utf-8' }
                Send-Response $context 200 $type ([IO.File]::ReadAllBytes($file))
            } else {
                Send-Json $context 404 @{ error = 'Not found.' }
            }
        } catch {
            Write-Warning $_.Exception.Message
            try { Send-Json $context 500 @{ error = $_.Exception.Message } } catch { Write-Warning $_.Exception.Message }
        }
    }
} finally {
    $listener.Close()
}
