[CmdletBinding()]
param(
  [string] $DistDir = "dist",
  [string] $ExpectedPublisher = $env:WINDOWS_PUBLISHER_NAME,
  [string] $ExpectedCertificatePath = "resources/windows/chordvox-local-code-signing.cer",
  [string] $SourceSha = $env:GITHUB_SHA,
  [string] $EvidencePath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string] $Message) {
  throw "[windows-authenticode] $Message"
}

if ($env:OS -ne "Windows_NT") {
  Fail "Authenticode verification must run on Windows."
}

$ExpectedPublisher = $ExpectedPublisher.Trim()
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
  Fail "WINDOWS_PUBLISHER_NAME is required and must match the certificate common name."
}

if (-not (Test-Path -LiteralPath $ExpectedCertificatePath -PathType Leaf)) {
  Fail "Pinned Windows signing certificate is missing: $ExpectedCertificatePath"
}
$PinnedCertificatePath = (Resolve-Path -LiteralPath $ExpectedCertificatePath).ProviderPath
$PinnedCertificate = Get-PfxCertificate -FilePath $PinnedCertificatePath
$PinnedPublisher = $PinnedCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
).Trim()
if ($PinnedPublisher -cne $ExpectedPublisher) {
  Fail "Pinned certificate publisher mismatch. expected='$ExpectedPublisher' actual='$PinnedPublisher'"
}
$PinnedThumbprint = $PinnedCertificate.Thumbprint.ToUpperInvariant()

$DistRoot = (Resolve-Path -LiteralPath $DistDir).ProviderPath
if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
  $EvidencePath = Join-Path $DistRoot "windows-authenticode-evidence.json"
} elseif (-not [System.IO.Path]::IsPathRooted($EvidencePath)) {
  $EvidencePath = Join-Path (Get-Location).ProviderPath $EvidencePath
}

$ActualSourceSha = (& git rev-parse HEAD).Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($SourceSha)) {
  $SourceSha = $ActualSourceSha
}
$SourceSha = $SourceSha.Trim().ToLowerInvariant()
if ($SourceSha -notmatch '^[0-9a-f]{40}$') {
  Fail "SourceSha must be a full 40-character Git SHA."
}
if ($SourceSha -ne $ActualSourceSha) {
  Fail "Source SHA mismatch. expected=$SourceSha actual=$ActualSourceSha"
}

$PackageJson = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
$Version = [string] $PackageJson.version
$ReleaseExecutables = @(
  Get-ChildItem -LiteralPath $DistRoot -File -Filter "*.exe" |
    Where-Object {
      $_.Name -like "*$Version*" -and
      $_.Name -notin @("windows-fast-paste.exe", "windows-key-listener.exe", "nircmd.exe")
    } |
    Sort-Object Name
)
if ($ReleaseExecutables.Count -ne 2) {
  Fail "Expected exactly two top-level Windows release executables (NSIS and Portable), found $($ReleaseExecutables.Count)."
}

$UnpackedExecutable = Join-Path $DistRoot "win-unpacked\ChordVox.exe"
if (-not (Test-Path -LiteralPath $UnpackedExecutable -PathType Leaf)) {
  Fail "Missing unpacked application executable: $UnpackedExecutable"
}

$FilesToVerify = @($ReleaseExecutables) + @(Get-Item -LiteralPath $UnpackedExecutable)
$SignerThumbprint = ""
$EvidenceAssets = @()

foreach ($File in $FilesToVerify) {
  $Signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    Fail "$($File.Name) has invalid Authenticode status: $($Signature.Status) $($Signature.StatusMessage)"
  }
  if ($null -eq $Signature.SignerCertificate) {
    Fail "$($File.Name) does not expose a signer certificate."
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    Fail "$($File.Name) is signed but does not contain a trusted timestamp."
  }

  $Publisher = $Signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  ).Trim()
  if ($Publisher -cne $ExpectedPublisher) {
    Fail "$($File.Name) publisher mismatch. expected='$ExpectedPublisher' actual='$Publisher'"
  }

  $Thumbprint = $Signature.SignerCertificate.Thumbprint.ToUpperInvariant()
  if ($Thumbprint -ne $PinnedThumbprint) {
    Fail "$($File.Name) was not signed by the pinned ChordVox Windows certificate."
  }
  if ([string]::IsNullOrWhiteSpace($SignerThumbprint)) {
    $SignerThumbprint = $Thumbprint
  } elseif ($SignerThumbprint -ne $Thumbprint) {
    Fail "Windows assets were signed by different certificates."
  }

  # Windows PowerShell 5.1 does not expose .NET Core's GetRelativePath API.
  # Keep the release gate runnable on the supported inbox PowerShell runtime.
  $RelativePath = $File.FullName.Substring($DistRoot.Length).TrimStart([char[]]@('\', '/'))
  $EvidenceAssets += [ordered]@{
    path = $RelativePath
    sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    sizeBytes = [int64] $File.Length
    status = "Valid"
    publisherName = $Publisher
    signerThumbprint = $Thumbprint
    timestamped = $true
    timestampCertificateThumbprint = $Signature.TimeStamperCertificate.Thumbprint.ToUpperInvariant()
  }
}

$Evidence = [ordered]@{
  schemaVersion = 1
  sourceSha = $SourceSha
  version = $Version
  platform = "windows-x64"
  publisherName = $ExpectedPublisher
  signerThumbprint = $SignerThumbprint
  certificateSha256 = (Get-FileHash -LiteralPath $PinnedCertificatePath -Algorithm SHA256).Hash.ToLowerInvariant()
  generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  assets = $EvidenceAssets
}

$EvidenceDirectory = Split-Path -Parent $EvidencePath
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$TemporaryEvidencePath = "$EvidencePath.tmp-$PID"
$Json = $Evidence | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText(
  $TemporaryEvidencePath,
  "$Json`n",
  [System.Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $TemporaryEvidencePath -Destination $EvidencePath -Force

Write-Host "[windows-authenticode] PASSED"
Write-Host "[windows-authenticode] publisher: $ExpectedPublisher"
Write-Host "[windows-authenticode] signer thumbprint: $SignerThumbprint"
Write-Host "[windows-authenticode] evidence: $EvidencePath"
