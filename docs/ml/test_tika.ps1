param(
    [string]$BaseUrl = 'http://127.0.0.1:9998'
)

$ErrorActionPreference = 'Stop'
$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1', 'localhost')) {
    throw 'The benchmark only sends sample bytes to a local HTTP server.'
}
$endpoint = $BaseUrl.TrimEnd('/') + '/detect/stream'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Import-Csv -LiteralPath (Join-Path $PSScriptRoot 'file-recognition-manifest.csv')
$challenge = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'independent-source-results.json') -Raw | ConvertFrom-Json
$samples = @()

foreach ($row in $manifest) {
    $group = if ($row.sample_id -like 'pilot-renamed-*') {
        'renamed-smoke'
    } elseif ($row.sample_id -eq 'demo-pptx-001') {
        'separate-source-pptx'
    } elseif ($row.format_label -eq 'OUT_OF_SCOPE') {
        'out-of-scope'
    } else {
        'synthetic-known'
    }
    $samples += [pscustomobject]@{
        sample_id = $row.sample_id
        relative_path = $row.relative_path
        expected_sha256 = $row.sha256
        actual = $row.format_label
        group = $group
        source_group = $row.source_group
    }
}
foreach ($row in $challenge.cases) {
    $samples += [pscustomobject]@{
        sample_id = $row.case_id
        relative_path = $row.relative_path
        expected_sha256 = $row.sha256
        actual = $row.actual
        group = 'independent-source'
        source_group = $row.source_group
    }
}

function Convert-MimeToLabel([string]$mime) {
    switch ($mime.ToLowerInvariant().Split(';')[0].Trim()) {
        'application/pdf' { return 'PDF' }
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' { return 'DOCX' }
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' { return 'PPTX' }
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' { return 'XLSX' }
        'application/json' { return 'JSON' }
        'text/csv' { return 'CSV' }
        'text/plain' { return 'TXT' }
        'application/zip' { return 'ZIP' }
        default { return 'OUT_OF_SCOPE' }
    }
}

$results = @()
foreach ($sample in $samples) {
    $path = (Resolve-Path -LiteralPath (Join-Path $root $sample.relative_path)).Path
    if (-not $path.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Sample outside repository: $($sample.sample_id)"
    }
    $sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($sha256 -ne $sample.expected_sha256.ToUpperInvariant()) {
        throw "Sample hash changed: $($sample.sample_id)"
    }
    foreach ($mode in @('content_only', 'filename_hint')) {
        $curlArgs = @('-sS', '-f', '-X', 'PUT', '--data-binary', ('@' + $path))
        if ($mode -eq 'filename_hint') {
            $name = [IO.Path]::GetFileName($path).Replace('"', '')
            $curlArgs += @('-H', ('Content-Disposition: attachment; filename="' + $name + '"'))
        }
        $curlArgs += $endpoint
        $mime = ((& curl.exe @curlArgs) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $mime -notmatch '^[a-z0-9.+-]+/[a-z0-9.+-]+') {
            throw "Tika request failed for $($sample.sample_id) ($mode): $mime"
        }
        $label = Convert-MimeToLabel $mime
        $results += [pscustomobject]@{
            sample_id = $sample.sample_id
            group = $sample.group
            source_group = $sample.source_group
            actual = $sample.actual
            mode = $mode
            tika_mime = $mime
            tika_label = $label
            correct = ($label -eq $sample.actual)
        }
    }
}

$summary = @()
foreach ($group in ($results.group | Sort-Object -Unique)) {
    foreach ($mode in @('content_only', 'filename_hint')) {
        $subset = @($results | Where-Object { $_.group -eq $group -and $_.mode -eq $mode })
        $summary += [pscustomobject]@{
            group = $group
            mode = $mode
            total = $subset.Count
            correct = @($subset | Where-Object { $_.correct }).Count
        }
    }
}
$output = [ordered]@{
    experiment = 'Apache Tika local detector benchmark'
    tika_version = '3.3.2'
    endpoint = $endpoint
    sample_count = $samples.Count
    request_count = $results.Count
    score_note = 'Tika MIME values are mapped to the eight pilot labels plus OUT_OF_SCOPE; JSON/CSV may need filename hints.'
    summary = $summary
    results = $results
}
$outputPath = Join-Path $PSScriptRoot 'tika-results.json'
$output | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8
$summary | Format-Table -AutoSize
"Saved $outputPath"
