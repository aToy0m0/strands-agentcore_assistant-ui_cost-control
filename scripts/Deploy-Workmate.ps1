[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "deploy-config.psd1")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Deployment config not found: $ConfigPath. Copy deploy-config.example.psd1 and set actual values."
}

$config = Import-PowerShellDataFile -LiteralPath $ConfigPath

function Get-RequiredConfigString {
    param([Parameter(Mandatory)][string]$Name)

    $value = $config[$Name]
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value) -or $value.Contains("<")) {
        throw "Deployment config '$Name' must contain an actual value."
    }
    return $value.Trim()
}

$profile = Get-RequiredConfigString "Profile"
$region = Get-RequiredConfigString "Region"
$webDebugMode = Get-RequiredConfigString "WebDebugMode"
$knowledgeBaseId = Get-RequiredConfigString "KnowledgeBaseId"
if ($knowledgeBaseId -notmatch '^[0-9A-Z]{10}$') {
    throw "Deployment config 'KnowledgeBaseId' must be a 10-character uppercase alphanumeric ID."
}
if ($webDebugMode -notin @("on", "off")) {
    throw "Deployment config 'WebDebugMode' must be 'on' or 'off'."
}

$contexts = [ordered]@{
    cognitoDomainPrefix = Get-RequiredConfigString "CognitoDomainPrefix"
}

if ($config.CustomDomainEnabled -isnot [bool]) {
    throw "Deployment config 'CustomDomainEnabled' must be `$true or `$false."
}
$contexts.customDomainEnabled = $config.CustomDomainEnabled.ToString().ToLowerInvariant()
if ($config.CustomDomainEnabled) {
    $contexts.customDomainName = Get-RequiredConfigString "CustomDomainName"
    $contexts.hostedZoneId = Get-RequiredConfigString "HostedZoneId"
    $contexts.hostedZoneName = Get-RequiredConfigString "HostedZoneName"
    $contexts.certificateArn = Get-RequiredConfigString "CertificateArn"
}

if ($config.EntraEnabled -isnot [bool]) {
    throw "Deployment config 'EntraEnabled' must be `$true or `$false."
}

$contexts.entraEnabled = $config.EntraEnabled.ToString().ToLowerInvariant()
if ($config.EntraEnabled) {
    $contexts.entraTenantId = Get-RequiredConfigString "EntraTenantId"
    $contexts.entraClientId = Get-RequiredConfigString "EntraClientId"
    $contexts.entraClientSecretName = Get-RequiredConfigString "EntraClientSecretName"
}

$optionalContexts = [ordered]@{
    loginMethods      = "LoginMethods"
    logRetentionDays  = "LogRetentionDays"
    runtimeLogRequest = "RuntimeLogRequest"
    runtimeLogModel   = "RuntimeLogModel"
    runtimeLogTool    = "RuntimeLogTool"
    accountMonthlyBudgetUsd = "AccountMonthlyBudgetUsd"
    projectMonthlyBudgetUsd = "ProjectMonthlyBudgetUsd"
}
foreach ($entry in $optionalContexts.GetEnumerator()) {
    $value = $config[$entry.Value]
    if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
        $contexts[$entry.Key] = [string]$value
    }
}
$contexts.webDebugMode = $webDebugMode

if ($null -eq $config.UserLimitProfiles) {
    throw "Deployment config 'UserLimitProfiles' is required."
}
$userLimitProfilesJson = ConvertTo-Json -InputObject @($config.UserLimitProfiles) -Depth 4 -Compress
$contexts.userLimitProfilesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($userLimitProfilesJson)).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$npmArguments = @(
    "run", "deploy", "--",
    "--profile", $profile,
    "--region", $region,
    "--parameters", "WorkmateCostControlStack:KnowledgeBaseId=$knowledgeBaseId"
)
foreach ($entry in $contexts.GetEnumerator()) {
    $npmArguments += @("-c", "$($entry.Key)=$($entry.Value)")
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $projectRoot
try {
    & npm.cmd @npmArguments
    if ($LASTEXITCODE -ne 0) {
        throw "CDK deployment failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
