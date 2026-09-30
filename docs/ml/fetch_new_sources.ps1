$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$plan = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'new-source-plan.json') -Raw | ConvertFrom-Json
$dataDir = Join-Path $PSScriptRoot 'new-source-files'
$manifestPath = Join-Path $PSScriptRoot 'new-source-manifest.json'
$frozen = if (Test-Path -LiteralPath $manifestPath) {
    Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} else { $null }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$allowedHosts = @(
    'raw.githubusercontent.com', 'earthquake.usgs.gov', 'power.larc.nasa.gov',
    'www.gutenberg.org', 'www.rfc-editor.org'
)
$seen = @{}
$samples = @()
if ($frozen -and $frozen.samples.Count -ne $plan.samples.Count) {
    throw 'Frozen manifest and download plan have different sample counts'
}
foreach ($sample in $plan.samples) {
    if ($sample.id -notmatch '^[a-z0-9-]+$' -or
        $sample.filename -notmatch '^[a-z0-9-]+\.(pptx|json|csv|txt)$' -or
        $seen.ContainsKey($sample.id)) {
        throw "Invalid or duplicate sample ID: $($sample.id)"
    }
    $seen[$sample.id] = $true
    $uri = [Uri]$sample.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin $allowedHosts) {
        throw "Unapproved download source: $($sample.url)"
    }
    $target = Join-Path $dataDir $sample.filename
    $part = $target + '.part'
    if (-not (Test-Path -LiteralPath $target)) {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        & curl.exe -fLsS --retry 2 --connect-timeout 15 --max-time 90 --max-filesize 8388608 -o $part $sample.url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $part)) {
            if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
            throw "Download failed: $($sample.id)"
        }
        Move-Item -LiteralPath $part -Destination $target
    }
    $file = Get-Item -LiteralPath $target
    if ($file.Length -eq 0 -or $file.Length -gt 8388608) {
        throw "Empty or oversized sample: $($sample.id)"
    }
    $relative = 'docs/ml/new-source-files/' + $sample.filename
    $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($frozen) {
        $expected = @($frozen.samples | Where-Object { $_.sample_id -eq $sample.id })
        if ($expected.Count -ne 1 -or $expected[0].sha256 -ne $digest -or
            $expected[0].source_url -ne $sample.url) {
            throw "Frozen sample changed: $($sample.id)"
        }
    }
    $samples += [ordered]@{
        sample_id = $sample.id
        relative_path = $relative
        sha256 = $digest
        bytes = $file.Length
        format_label = $sample.label
        source_group = $sample.source_group
        source_url = $sample.url
        split = 'new_source_holdout'
        review_status = 'pending'
    }
    Write-Output "$($sample.id): $($file.Length) bytes"
}
$manifest = [ordered]@{
    purpose = 'Source-separated local challenge; downloaded files are Git-ignored'
    label_status = 'pending human review'
    samples = $samples
}
if ($frozen) {
    Write-Output "Verified frozen manifest $manifestPath"
} else {
    $json = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Saved $manifestPath"
}
