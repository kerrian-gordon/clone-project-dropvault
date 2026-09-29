$ErrorActionPreference = 'Stop'
$planPath = Join-Path $PSScriptRoot 'holdout-v2-plan.json'
$manifestPath = Join-Path $PSScriptRoot 'holdout-v2-manifest.json'
$dataDir = Join-Path $PSScriptRoot 'holdout-v2-files'
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
$frozen = if (Test-Path -LiteralPath $manifestPath) {
    Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} else { $null }
if ($frozen -and $frozen.samples.Count -ne $plan.samples.Count) {
    throw 'Frozen manifest and plan disagree on sample count'
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$samples = @()
foreach ($sample in $plan.samples) {
    if ($sample.id -cnotmatch '^[a-z0-9-]+$' -or
        $sample.filename -cnotmatch '^[a-z0-9-]+\.(csv|txt|pdf)$') {
        throw "Invalid sample path: $($sample.id)"
    }
    $uri = [Uri]$sample.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'raw.githubusercontent.com') {
        throw "Unapproved source: $($sample.url)"
    }
    $target = Join-Path $dataDir $sample.filename
    $part = $target + '.part'
    if (-not (Test-Path -LiteralPath $target)) {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        & curl.exe -fLsS --retry 2 --connect-timeout 15 --max-time 90 --max-filesize $plan.max_bytes_per_file -o $part $sample.url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $part)) {
            throw "Download failed: $($sample.id)"
        }
        Move-Item -LiteralPath $part -Destination $target
    }
    $file = Get-Item -LiteralPath $target
    if ($file.Length -eq 0 -or $file.Length -gt $plan.max_bytes_per_file) {
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
        relative_path = 'docs/ml/holdout-v2-files/' + $sample.filename
        expected = $sample.expected
        condition = $sample.condition
        source_group = $sample.source_group
        source_url = $sample.url
        sha256 = $digest
        bytes = $file.Length
        review_status = 'pending'
    }
    Write-Output "$($sample.id): $($file.Length) bytes"
}
if ($frozen) {
    Write-Output "Verified frozen manifest $manifestPath"
} else {
    $manifest = [ordered]@{
        purpose = $plan.purpose
        label_status = $plan.label_status
        samples = $samples
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) +
        [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Saved $manifestPath"
}
