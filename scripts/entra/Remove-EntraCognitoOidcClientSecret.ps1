[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ApplicationClientId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ClientSecretKeyId,

    [switch]$UseDeviceCode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0
. (Join-Path $PSScriptRoot 'EntraGraphSession.ps1')

$ownsConnection = Connect-EntraGraphSession `
    -TenantId $TenantId `
    -RequiredScopes @('Application.ReadWrite.All') `
    -UseDeviceCode:$UseDeviceCode

try {
    $application = Invoke-MgGraphRequest `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/applications(appId='$ApplicationClientId')?`$select=id,appId,displayName,passwordCredentials"
    $credentials = @($application.passwordCredentials)
    $target = @($credentials | Where-Object { [string]$_.keyId -eq $ClientSecretKeyId })
    if ($target.Count -ne 1) {
        throw "Expected exactly one client secret with KeyId=$ClientSecretKeyId. Count=$($target.Count)"
    }

    $now = [DateTimeOffset]::UtcNow
    $otherActiveCredentials = @($credentials | Where-Object {
        [string]$_.keyId -ne $ClientSecretKeyId -and [DateTimeOffset]::Parse($_.endDateTime) -gt $now
    })
    if ($otherActiveCredentials.Count -lt 1) {
        throw 'Refusing to remove the secret because no other active client secret exists.'
    }

    if (-not $PSCmdlet.ShouldProcess($application.displayName, "Remove client secret KeyId=$ClientSecretKeyId")) {
        return
    }

    $body = @{ keyId = $ClientSecretKeyId } | ConvertTo-Json
    Invoke-MgGraphRequest `
        -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)/removePassword" `
        -Body $body `
        -ContentType 'application/json'

    [pscustomobject]@{
        ApplicationClientId = $application.appId
        RemovedKeyId        = $ClientSecretKeyId
        RemainingActiveSecrets = $otherActiveCredentials.Count
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
