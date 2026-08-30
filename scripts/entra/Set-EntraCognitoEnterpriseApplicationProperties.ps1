[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
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
    $filter = [Uri]::EscapeDataString("appId eq '$ApplicationClientId'")
    $collectionUri = "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=$filter&`$select=id,appId,displayName,accountEnabled,appRoleAssignmentRequired,tags"
    $response = Invoke-MgGraphRequest -Method GET -Uri $collectionUri
    $servicePrincipals = @($response.value)

    if ($servicePrincipals.Count -ne 1) {
        throw "Expected exactly one service principal. Count=$($servicePrincipals.Count), ClientId=$ApplicationClientId"
    }

    $servicePrincipal = $servicePrincipals[0]
    $currentTags = @($servicePrincipal.tags)
    $desiredTags = @($currentTags + 'HideApp' | Sort-Object -Unique)

    Write-Output ([pscustomobject]@{
        Phase                     = 'Before'
        DisplayName               = $servicePrincipal.displayName
        ApplicationClientId       = $servicePrincipal.appId
        ServicePrincipalObjectId  = $servicePrincipal.id
        AccountEnabled            = [bool]$servicePrincipal.accountEnabled
        AppRoleAssignmentRequired = [bool]$servicePrincipal.appRoleAssignmentRequired
        UserVisible               = -not ($currentTags -contains 'HideApp')
        Tags                      = $currentTags
    })

    if (-not $PSCmdlet.ShouldProcess(
        $servicePrincipal.displayName,
        'Require user assignment and hide the Enterprise Application from users'
    )) {
        return
    }

    $body = @{
        appRoleAssignmentRequired = $true
        tags                      = $desiredTags
    } | ConvertTo-Json -Depth 5

    Invoke-MgGraphRequest `
        -Method PATCH `
        -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($servicePrincipal.id)" `
        -Body $body `
        -ContentType 'application/json'

    $verified = Invoke-MgGraphRequest `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($servicePrincipal.id)?`$select=id,appId,displayName,accountEnabled,appRoleAssignmentRequired,tags"

    $verifiedTags = @($verified.tags)
    if (-not [bool]$verified.appRoleAssignmentRequired) {
        throw 'Verification failed: appRoleAssignmentRequired is not true.'
    }
    if ($verifiedTags -notcontains 'HideApp') {
        throw 'Verification failed: HideApp tag is missing.'
    }

    [pscustomobject]@{
        Phase                     = 'After'
        DisplayName               = $verified.displayName
        ApplicationClientId       = $verified.appId
        ServicePrincipalObjectId  = $verified.id
        AccountEnabled            = [bool]$verified.accountEnabled
        AppRoleAssignmentRequired = [bool]$verified.appRoleAssignmentRequired
        UserVisible               = -not ($verifiedTags -contains 'HideApp')
        Tags                      = $verifiedTags
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
