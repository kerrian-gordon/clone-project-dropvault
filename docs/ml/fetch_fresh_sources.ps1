param([ValidateSet('fresh-csv', 'preamble-csv', 'fresh-txt')][string]$Set = 'fresh-csv')
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath (Join-Path $PSScriptRoot "$Set-plan.json") -Raw | ConvertFrom-Json
$dataDir = Join-Path $PSScriptRoot "$Set-files"
$manifestPath = Join-Path $PSScriptRoot "$Set-manifest.json"
$frozen = if (Test-Path -LiteralPath $manifestPath) {
    Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} else { $null }
if ($frozen -and $frozen.samples.Count -ne $plan.samples.Count) {
    throw 'Frozen manifest and plan disagree on sample count'
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$samples = @()
foreach ($sample in $plan.samples) {
    if ($sample.id -notmatch '^[a-z0-9-]+$' -or
        $sample.filename -notmatch '^[a-z0-9-]+\.(csv|txt)$') {
        throw "Invalid sample: $($sample.id)"
    }
    $uri = [Uri]$sample.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @(
        'raw.githubusercontent.com', 'data.giss.nasa.gov', 'www.gnu.org')) {
        throw "Unapproved source: $($sample.url)"
    }
    $target = Join-Path $dataDir $sample.filename
    $part = $target + '.part'
    if (-not (Test-Path -LiteralPath $target)) {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        & curl.exe -fLsS --retry 2 --connect-timeout 15 --max-time 90 --max-filesize 8388608 -o $part $sample.url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $part)) {
            throw "Download failed: $($sample.id)"
        }
        Move-Item -LiteralPath $part -Destination $target
    }
    $file = Get-Item -LiteralPath $target
    if ($file.Length -eq 0 -or $file.Length -gt 8388608) {
        throw "Invalid file size: $($sample.id)"
    }
    $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($frozen) {
        $prior = @($frozen.samples | Where-Object { $_.sample_id -eq $sample.id })
        if ($prior.Count -ne 1 -or $prior[0].sha256 -ne $digest -or
            $prior[0].source_url -ne $sample.url) {
            throw "Frozen sample changed: $($sample.id)"
        }
    }
    $samples += [ordered]@{
        sample_id = $sample.id
        relative_path = 'docs/ml/' + $Set + '-files/' + $sample.filename
        sha256 = $digest
        bytes = $file.Length
        format_label = if ($Set -eq 'fresh-txt') { 'TXT' } else { 'CSV' }
        source_group = $sample.source_group
        source_url = $sample.url
        split = $Set.Replace('-', '_') + '_holdout'
        review_status = 'pending'
    }
    Write-Output "$($sample.id): $($file.Length) bytes"
}
if ($frozen) {
    Write-Output "Verified frozen manifest $manifestPath"
} else {
    $manifest = [ordered]@{
        purpose = $plan.purpose
        label_status = 'pending human review'
        samples = $samples
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) +
        [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Saved $manifestPath"
}
