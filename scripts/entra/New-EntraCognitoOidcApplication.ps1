[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$DisplayName,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$CognitoUserPoolDomainHost,

    [ValidateRange(1, 730)]
    [int]$ClientSecretValidityDays = 180,

    [ValidateNotNullOrEmpty()]
    [string]$ClientSecretDisplayName = 'cognito-oidc',

    [switch]$UseDeviceCode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0
. (Join-Path $PSScriptRoot 'EntraGraphSession.ps1')

$redirectUri = "https://$CognitoUserPoolDomainHost/oauth2/idpresponse"
$escapedDisplayName = $DisplayName.Replace("'", "''")
$filter = [Uri]::EscapeDataString("displayName eq '$escapedDisplayName'")
$lookupUri = "https://graph.microsoft.com/v1.0/applications?`$filter=$filter&`$select=id,appId,displayName"

$ownsConnection = Connect-EntraGraphSession `
    -TenantId $TenantId `
    -RequiredScopes @('Application.ReadWrite.All') `
    -UseDeviceCode:$UseDeviceCode

try {
    $existing = Invoke-MgGraphRequest -Method GET -Uri $lookupUri
    if (@($existing.value).Count -ne 0) {
        throw "An application with the same displayName already exists: $DisplayName"
    }

    $graphAppId = '00000003-0000-0000-c000-000000000000'
    $graphFilter = [Uri]::EscapeDataString("appId eq '$graphAppId'")
    $graphResponse = Invoke-MgGraphRequest `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=$graphFilter&`$select=appId,oauth2PermissionScopes"
    $graphServicePrincipals = @($graphResponse.value)
    if ($graphServicePrincipals.Count -ne 1) {
        throw "Expected exactly one Microsoft Graph service principal. Count=$($graphServicePrincipals.Count)"
    }
    $desiredScopes = foreach ($scopeName in @('openid', 'email')) {
        $matches = @($graphServicePrincipals[0].oauth2PermissionScopes | Where-Object {
            $_.value -eq $scopeName -and $_.isEnabled
        })
        if ($matches.Count -ne 1) {
            throw "Expected exactly one enabled Microsoft Graph scope named '$scopeName'. Count=$($matches.Count)"
        }
        $matches[0]
    }

    if (-not $PSCmdlet.ShouldProcess($DisplayName, 'Create the Entra application, service principal, and client secret')) {
        return
    }

    $applicationBody = @{
        displayName    = $DisplayName
        signInAudience = 'AzureADMyOrg'
        web            = @{
            redirectUris         = @($redirectUri)
            implicitGrantSettings = @{
                enableAccessTokenIssuance = $false
                enableIdTokenIssuance     = $false
            }
        }
        requiredResourceAccess = @(
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
    } | ConvertTo-Json -Depth 10

    $application = Invoke-MgGraphRequest `
        -Method POST `
        -Uri 'https://graph.microsoft.com/v1.0/applications' `
        -Body $applicationBody `
        -ContentType 'application/json'

    try {
        $servicePrincipalBody = @{
            appId                     = $application.appId
            appRoleAssignmentRequired = $true
            tags                      = @('HideApp')
        } | ConvertTo-Json -Depth 5
        $servicePrincipal = Invoke-MgGraphRequest `
            -Method POST `
            -Uri 'https://graph.microsoft.com/v1.0/servicePrincipals' `
            -Body $servicePrincipalBody `
            -ContentType 'application/json'

        $secretEndDateTime = [DateTimeOffset]::UtcNow.AddDays($ClientSecretValidityDays).ToString('o')
        $secretBody = @{
            passwordCredential = @{
                displayName = $ClientSecretDisplayName
                endDateTime = $secretEndDateTime
            }
        } | ConvertTo-Json -Depth 5

        $credential = Invoke-MgGraphRequest `
            -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)/addPassword" `
            -Body $secretBody `
            -ContentType 'application/json'
    }
    catch {
        throw "The Entra application was created, but a subsequent operation failed. ObjectId=$($application.id), ClientId=$($application.appId). Cause: $($_.Exception.Message)"
    }

    Write-Warning 'ClientSecret is returned only once. Register it in Cognito or an approved secret store immediately. Do not save it in the repository or logs.'

    [pscustomobject]@{
        TenantId                 = $TenantId
        ApplicationObjectId      = $application.id
        ApplicationClientId      = $application.appId
        ServicePrincipalObjectId = $servicePrincipal.id
        AppRoleAssignmentRequired = $true
        UserVisible               = $false
        DisplayName              = $application.displayName
        SignInAudience           = $application.signInAudience
        RedirectUri              = $redirectUri
        ClientSecretKeyId        = $credential.keyId
        ClientSecretExpiresAt    = $credential.endDateTime
        ClientSecret             = $credential.secretText
        CognitoOidcIssuer        = "https://login.microsoftonline.com/$TenantId/v2.0"
        CognitoAuthorizedScopes  = 'openid email'
    }
}
finally {
    Disconnect-EntraGraphSession -OwnsConnection $ownsConnection
}
