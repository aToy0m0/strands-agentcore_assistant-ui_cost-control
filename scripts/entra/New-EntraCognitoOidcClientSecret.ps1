[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ApplicationClientId,

    [ValidateRange(1, 730)]
    [int]$ValidityDays = 180,

    [ValidateNotNullOrEmpty()]
    [string]$DisplayName = 'cognito-oidc-rotation',

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

    if (-not $PSCmdlet.ShouldProcess($application.displayName, "Add a client secret valid for $ValidityDays days")) {
        return
    }

    $endDateTime = [DateTimeOffset]::UtcNow.AddDays($ValidityDays).ToString('o')
    $body = @{
        passwordCredential = @{
            displayName = $DisplayName
            endDateTime = $endDateTime
        }
    } | ConvertTo-Json -Depth 5

    $credential = Invoke-MgGraphRequest `
        -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)/addPassword" `
        -Body $body `
        -ContentType 'application/json'

    Write-Warning 'ClientSecret is returned only once. Pass it directly to Cognito and do not write it to files or command history.'
    [pscustomobject]@{
        TenantId            = $TenantId
        ApplicationClientId = $application.appId
        ApplicationObjectId = $application.id
        ClientSecretKeyId   = $credential.keyId
        ClientSecretStartsAt = $credential.startDateTime
        ClientSecretExpiresAt = $credential.endDateTime
        ClientSecret        = $credential.secretText
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
