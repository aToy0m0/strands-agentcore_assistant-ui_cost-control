[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ApplicationClientId,

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
    $graphAppId = '00000003-0000-0000-c000-000000000000'
    $graphFilter = [Uri]::EscapeDataString("appId eq '$graphAppId'")
    $graphResponse = Invoke-MgGraphRequest `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=$graphFilter&`$select=appId,oauth2PermissionScopes"
    $graphServicePrincipals = @($graphResponse.value)
    if ($graphServicePrincipals.Count -ne 1) {
        throw "Expected exactly one Microsoft Graph service principal. Count=$($graphServicePrincipals.Count)"
    }

    $graphServicePrincipal = $graphServicePrincipals[0]
    $desiredScopeNames = @('openid', 'email')
    $desiredScopes = foreach ($scopeName in $desiredScopeNames) {
        $matches = @($graphServicePrincipal.oauth2PermissionScopes | Where-Object {
            $_.value -eq $scopeName -and $_.isEnabled
        })
        if ($matches.Count -ne 1) {
            throw "Expected exactly one enabled Microsoft Graph delegated scope named '$scopeName'. Count=$($matches.Count)"
        }
        $matches[0]
    }

    $applicationUri = "https://graph.microsoft.com/v1.0/applications(appId='$ApplicationClientId')?`$select=id,appId,displayName,requiredResourceAccess"
    $application = Invoke-MgGraphRequest -Method GET -Uri $applicationUri

    $scopeNameById = @{}
    foreach ($scope in $graphServicePrincipal.oauth2PermissionScopes) {
        $scopeNameById[[string]$scope.id] = $scope.value
    }
    $currentPermissions = foreach ($resource in @($application.requiredResourceAccess)) {
        foreach ($permission in @($resource.resourceAccess)) {
            [pscustomobject]@{
                ResourceAppId = $resource.resourceAppId
                PermissionId  = $permission.id
                Type          = $permission.type
                Value         = if ($resource.resourceAppId -eq $graphAppId) {
                    $scopeNameById[[string]$permission.id]
                }
                else {
                    $null
                }
            }
        }
    }

    Write-Output ([pscustomobject]@{
        Phase              = 'Before'
        ApplicationClientId = $application.appId
        Permissions        = @($currentPermissions)
    })

    $requiredResourceAccess = @(
        @{
            resourceAppId = $graphAppId
            resourceAccess = @($desiredScopes | ForEach-Object {
                @{
                    id   = $_.id
                    type = 'Scope'
                }
            })
        }
    )

    if (-not $PSCmdlet.ShouldProcess(
        $application.displayName,
        'Replace configured API permissions with Microsoft Graph delegated openid and email scopes'
    )) {
        return
    }

    $body = @{ requiredResourceAccess = $requiredResourceAccess } | ConvertTo-Json -Depth 10
    Invoke-MgGraphRequest `
        -Method PATCH `
        -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)" `
        -Body $body `
        -ContentType 'application/json'

    $verifiedApplication = Invoke-MgGraphRequest -Method GET -Uri $applicationUri
    $verifiedResources = @($verifiedApplication.requiredResourceAccess)
    if ($verifiedResources.Count -ne 1 -or $verifiedResources[0].resourceAppId -ne $graphAppId) {
        throw 'API permission verification failed: unexpected resource application.'
    }
    $verifiedPermissionIds = @($verifiedResources[0].resourceAccess | ForEach-Object { [string]$_.id } | Sort-Object)
    $desiredPermissionIds = @($desiredScopes | ForEach-Object { [string]$_.id } | Sort-Object)
    if (Compare-Object -ReferenceObject $desiredPermissionIds -DifferenceObject $verifiedPermissionIds) {
        throw 'API permission verification failed: configured delegated permissions do not match openid and email.'
    }

    [pscustomobject]@{
        Phase               = 'After'
        ApplicationClientId = $application.appId
        Permissions         = @($desiredScopeNames)
        UserReadRemoved      = $true
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
