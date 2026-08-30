[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$ApplicationClientId,

    [switch]$UseDeviceCode
)

# Grants tenant-wide admin consent for the Microsoft Graph delegated scopes that Cognito requests.
# Without a pre-granted consent, every assigned end user is prompted to consent at sign-in, and
# tenants that disable user consent reject the sign-in outright.
#
# Requires the Cloud Application Administrator role or higher.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0
. (Join-Path $PSScriptRoot 'EntraGraphSession.ps1')

$graphAppId = '00000003-0000-0000-c000-000000000000'
$desiredScopeNames = @('openid', 'email')

function Get-ServicePrincipalByAppId {
    param([Parameter(Mandatory)][string]$AppId)

    $filter = [Uri]::EscapeDataString("appId eq '$AppId'")
    $uri = "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=$filter&`$select=id,appId,displayName"
    $response = Invoke-MgGraphRequest -Method GET -Uri $uri
    $servicePrincipals = @($response.value)
    if ($servicePrincipals.Count -ne 1) {
        throw "Expected exactly one service principal. Count=$($servicePrincipals.Count), AppId=$AppId"
    }
    $servicePrincipals[0]
}

function Get-ScopeNames {
    param([string]$Scope)

    if ([string]::IsNullOrWhiteSpace($Scope)) { return @() }
    @($Scope -split '\s+' | Where-Object { $_ })
}

$ownsConnection = Connect-EntraGraphSession `
    -TenantId $TenantId `
    -RequiredScopes @('Application.Read.All', 'DelegatedPermissionGrant.ReadWrite.All') `
    -UseDeviceCode:$UseDeviceCode

try {
    $clientServicePrincipal = Get-ServicePrincipalByAppId -AppId $ApplicationClientId
    $graphServicePrincipal = Get-ServicePrincipalByAppId -AppId $graphAppId

    # The oauth2PermissionGrants $filter does not accept resourceId, so filter by clientId and match locally.
    $grantFilter = [Uri]::EscapeDataString("clientId eq '$($clientServicePrincipal.id)'")
    $grantResponse = Invoke-MgGraphRequest `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=$grantFilter"
    $existingGrants = @($grantResponse.value | Where-Object {
        $_.resourceId -eq $graphServicePrincipal.id -and $_.consentType -eq 'AllPrincipals'
    })
    if ($existingGrants.Count -gt 1) {
        throw "Expected at most one tenant-wide grant for Microsoft Graph. Count=$($existingGrants.Count)"
    }
    $existingGrant = if ($existingGrants.Count -eq 1) { $existingGrants[0] } else { $null }

    Write-Output ([pscustomobject]@{
        Phase               = 'Before'
        ApplicationClientId = $clientServicePrincipal.appId
        DisplayName         = $clientServicePrincipal.displayName
        ConsentType         = if ($existingGrant) { $existingGrant.consentType } else { $null }
        GrantedScopes       = if ($existingGrant) { Get-ScopeNames -Scope $existingGrant.scope } else { @() }
    })

    $target = "$($clientServicePrincipal.displayName) ($($clientServicePrincipal.appId))"
    $action = "Grant tenant-wide admin consent for Microsoft Graph delegated scopes: $($desiredScopeNames -join ', ')"
    if (-not $PSCmdlet.ShouldProcess($target, $action)) {
        return
    }

    $desiredScope = $desiredScopeNames -join ' '
    if ($existingGrant) {
        $body = @{ scope = $desiredScope } | ConvertTo-Json
        Invoke-MgGraphRequest `
            -Method PATCH `
            -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$($existingGrant.id)" `
            -Body $body `
            -ContentType 'application/json' | Out-Null
    }
    else {
        $body = @{
            clientId    = $clientServicePrincipal.id
            consentType = 'AllPrincipals'
            resourceId  = $graphServicePrincipal.id
            scope       = $desiredScope
        } | ConvertTo-Json
        Invoke-MgGraphRequest `
            -Method POST `
            -Uri 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' `
            -Body $body `
            -ContentType 'application/json' | Out-Null
    }

    $verifyResponse = Invoke-MgGraphRequest `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=$grantFilter"
    $verifiedGrants = @($verifyResponse.value | Where-Object {
        $_.resourceId -eq $graphServicePrincipal.id -and $_.consentType -eq 'AllPrincipals'
    })
    if ($verifiedGrants.Count -ne 1) {
        throw "Admin consent verification failed: expected exactly one tenant-wide grant. Count=$($verifiedGrants.Count)"
    }
    $verifiedScopeNames = @(Get-ScopeNames -Scope $verifiedGrants[0].scope | Sort-Object)
    if (Compare-Object -ReferenceObject @($desiredScopeNames | Sort-Object) -DifferenceObject $verifiedScopeNames) {
        throw "Admin consent verification failed: granted scopes do not match. Actual=$($verifiedGrants[0].scope)"
    }

    [pscustomobject]@{
        Phase               = 'After'
        ApplicationClientId = $clientServicePrincipal.appId
        DisplayName         = $clientServicePrincipal.displayName
        ConsentType         = 'AllPrincipals'
        GrantedScopes       = $verifiedScopeNames
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
