$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'new-source-manifest.json') -Raw | ConvertFrom-Json
$endpoint = 'http://127.0.0.1:9998/detect/stream'

function Convert-MimeToLabel([string]$mime) {
    switch ($mime.ToLowerInvariant().Split(';')[0].Trim()) {
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' { return 'PPTX' }
        'application/json' { return 'JSON' }
        'text/csv' { return 'CSV' }
        'text/plain' { return 'TXT' }
        default { return 'OUT_OF_SCOPE' }
    }
}

$results = @()
foreach ($sample in $manifest.samples) {
    if ($sample.relative_path -notmatch '^docs/ml/new-source-files/[a-z0-9-]+\.(pptx|json|csv|txt)$') {
        throw "Unexpected sample path: $($sample.sample_id)"
    }
    $path = (Resolve-Path -LiteralPath (Join-Path $root $sample.relative_path)).Path
    $sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($sha256 -ne $sample.sha256.ToUpperInvariant()) {
        throw "Sample hash changed: $($sample.sample_id)"
    }
    foreach ($mode in @('content_only', 'filename_hint')) {
        $curlArgs = @('-sS', '-f', '-X', 'PUT', '--data-binary', ('@' + $path))
        if ($mode -eq 'filename_hint') {
            $name = [IO.Path]::GetFileName($path)
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
            actual = $sample.format_label
            source_group = $sample.source_group
            mode = $mode
            tika_mime = $mime
            tika_label = $label
            correct = ($label -eq $sample.format_label)
        }
    }
}

$summary = @()
foreach ($label in @('PPTX','JSON','CSV','TXT')) {
    foreach ($mode in @('content_only','filename_hint')) {
        $subset = @($results | Where-Object { $_.actual -eq $label -and $_.mode -eq $mode })
        $summary += [pscustomobject]@{
            label = $label
            mode = $mode
            total = $subset.Count
            correct = @($subset | Where-Object { $_.correct }).Count
        }
    }
}
$output = [ordered]@{
    experiment = 'Tika 3.3.2 on frozen new-source holdout'
    endpoint = $endpoint
    sample_count = $manifest.samples.Count
    summary = $summary
    results = $results
}
$outputPath = Join-Path $PSScriptRoot 'new-source-tika-results.json'
$output | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $outputPath -Encoding UTF8
$summary | Format-Table -AutoSize
"Saved $outputPath"
