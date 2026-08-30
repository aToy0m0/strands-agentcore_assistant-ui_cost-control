[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$ApplicationClientId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$CurrentCognitoUserPoolDomainHost,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$NewCognitoUserPoolDomainHost,

    [switch]$UseDeviceCode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0
. (Join-Path $PSScriptRoot 'EntraGraphSession.ps1')

$currentRedirectUri = "https://$CurrentCognitoUserPoolDomainHost/oauth2/idpresponse"
$newRedirectUri = "https://$NewCognitoUserPoolDomainHost/oauth2/idpresponse"
$ownsConnection = Connect-EntraGraphSession `
    -TenantId $TenantId `
    -RequiredScopes @('Application.ReadWrite.All') `
    -UseDeviceCode:$UseDeviceCode

try {
    $applicationUri = "https://graph.microsoft.com/v1.0/applications(appId='$ApplicationClientId')?`$select=id,appId,displayName,web"
    $application = Invoke-MgGraphRequest -Method GET -Uri $applicationUri
    $redirectUris = @($application.web.redirectUris)

    if ($redirectUris -notcontains $currentRedirectUri) {
        throw "The expected current redirect URI was not found: $currentRedirectUri"
    }
    if ($redirectUris -contains $newRedirectUri) {
        throw "The new redirect URI already exists: $newRedirectUri"
    }

    $updatedRedirectUris = @($redirectUris | Where-Object { $_ -ne $currentRedirectUri }) + $newRedirectUri
    if (-not $PSCmdlet.ShouldProcess($application.displayName, "Replace redirect URI with $newRedirectUri")) {
        return
    }

    $body = @{
        web = @{
            redirectUris = $updatedRedirectUris
        }
    } | ConvertTo-Json -Depth 5

    Invoke-MgGraphRequest `
        -Method PATCH `
        -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)" `
        -Body $body `
        -ContentType 'application/json'

    [pscustomobject]@{
        TenantId            = $TenantId
        ApplicationClientId = $application.appId
        ApplicationObjectId = $application.id
        DisplayName         = $application.displayName
        PreviousRedirectUri = $currentRedirectUri
        RedirectUri         = $newRedirectUri
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
