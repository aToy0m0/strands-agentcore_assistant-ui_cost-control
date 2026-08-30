[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ApplicationClientId,

    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$ExpectedCognitoUserPoolDomainHost,

    [switch]$AsJson,

    [switch]$UseDeviceCode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0
. (Join-Path $PSScriptRoot 'EntraGraphSession.ps1')

$ownsConnection = Connect-EntraGraphSession `
    -TenantId $TenantId `
    -RequiredScopes @('Application.Read.All') `
    -UseDeviceCode:$UseDeviceCode

try {
    $applicationUri = "https://graph.microsoft.com/v1.0/applications(appId='$ApplicationClientId')?`$select=id,appId,displayName,signInAudience,web,passwordCredentials"
    $application = Invoke-MgGraphRequest -Method GET -Uri $applicationUri

    $servicePrincipalFilter = [Uri]::EscapeDataString("appId eq '$ApplicationClientId'")
    $servicePrincipalUri = "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=$servicePrincipalFilter&`$select=id,appId,displayName,accountEnabled,appRoleAssignmentRequired,tags"
    $servicePrincipalResponse = Invoke-MgGraphRequest -Method GET -Uri $servicePrincipalUri
    $servicePrincipals = @($servicePrincipalResponse.value)

    if ($servicePrincipals.Count -ne 1) {
        throw "Expected exactly one service principal. Count=$($servicePrincipals.Count), ClientId=$ApplicationClientId"
    }

    $servicePrincipal = $servicePrincipals[0]
    $servicePrincipalTags = @($servicePrincipal.tags)
    $redirectUris = @($application.web.redirectUris)
    $expectedRedirectUri = if ($ExpectedCognitoUserPoolDomainHost) {
        "https://$ExpectedCognitoUserPoolDomainHost/oauth2/idpresponse"
    }
    else {
        $null
    }

    $now = [DateTimeOffset]::UtcNow
    $credentialStatus = @($application.passwordCredentials | ForEach-Object {
        $expiresAt = [DateTimeOffset]::Parse($_.endDateTime)
        [pscustomobject]@{
            KeyId       = $_.keyId
            DisplayName = $_.displayName
            Hint        = $_.hint
            StartsAt    = $_.startDateTime
            ExpiresAt   = $_.endDateTime
            IsActive    = $expiresAt -gt $now
        }
    })

    $checks = [ordered]@{
        IsSingleTenant              = $application.signInAudience -eq 'AzureADMyOrg'
        HasServicePrincipal         = $true
        ServicePrincipalEnabled     = [bool]$servicePrincipal.accountEnabled
        UserAssignmentRequired      = [bool]$servicePrincipal.appRoleAssignmentRequired
        HiddenFromUsers             = $servicePrincipalTags -contains 'HideApp'
        ImplicitAccessTokenDisabled = -not [bool]$application.web.implicitGrantSettings.enableAccessTokenIssuance
        ImplicitIdTokenDisabled     = -not [bool]$application.web.implicitGrantSettings.enableIdTokenIssuance
        HasActiveClientSecret       = @($credentialStatus | Where-Object IsActive).Count -gt 0
    }

    if ($expectedRedirectUri) {
        $checks.ExpectedRedirectUriRegistered = $redirectUris -contains $expectedRedirectUri
    }

    $result = [pscustomobject]@{
        TenantId                     = $TenantId
        ApplicationObjectId           = $application.id
        ApplicationClientId           = $application.appId
        DisplayName                   = $application.displayName
        SignInAudience                = $application.signInAudience
        RedirectUris                  = $redirectUris
        ServicePrincipalObjectId      = $servicePrincipal.id
        AppRoleAssignmentRequired     = $servicePrincipal.appRoleAssignmentRequired
        UserVisible                   = -not ($servicePrincipalTags -contains 'HideApp')
        ServicePrincipalTags          = $servicePrincipalTags
        ClientSecretMetadata          = $credentialStatus
        Checks                        = [pscustomobject]$checks
        CognitoOidcIssuer             = "https://login.microsoftonline.com/$TenantId/v2.0"
        CognitoAuthorizedScopes       = 'openid email'
        CognitoAttributeRequestMethod = 'GET'
    }

    if ($AsJson) {
        $result | ConvertTo-Json -Depth 10
    }
    else {
        $result
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
