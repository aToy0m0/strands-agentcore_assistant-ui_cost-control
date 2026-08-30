# Shared Microsoft Graph session helper. Dot-source this file; do not run it directly.
#
# Reuses an existing Microsoft Graph connection when one is already established for the same
# tenant, and disconnects only when this script created the connection. Connect-MgGraph once at
# the start of a procedure and the scripts below will not prompt for browser sign-in again.
#
# This file intentionally does not call Set-StrictMode. Dot-sourcing applies it to the caller's
# scope, which would leak into the interactive session. Every calling script sets it already.

function Connect-EntraGraphSession {
    <#
    .SYNOPSIS
        Connects to Microsoft Graph when needed and reports whether this call owns the connection.
    .OUTPUTS
        [bool] True when this call established the connection, false when an existing session was reused.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string[]]$RequiredScopes,

        [switch]$UseDeviceCode
    )

    $context = Get-MgContext
    if ($null -ne $context) {
        if ($context.TenantId -ne $TenantId) {
            throw "Microsoft Graph tenant mismatch. Expected=$TenantId, Actual=$($context.TenantId). Run Disconnect-MgGraph before retrying."
        }

        $grantedScopes = @($context.Scopes)
        $missingScopes = @($RequiredScopes | Where-Object { $grantedScopes -notcontains $_ })
        if ($missingScopes.Count -gt 0) {
            $scopeList = ($RequiredScopes | ForEach-Object { "'$_'" }) -join ','
            throw "The existing Microsoft Graph session is missing required scopes. Missing=$($missingScopes -join ', '). Run Disconnect-MgGraph, then Connect-MgGraph -TenantId '$TenantId' -Scopes $scopeList"
        }

        return $false
    }

    $connectParameters = @{
        TenantId     = $TenantId
        Scopes       = $RequiredScopes
        ContextScope = 'Process'
        NoWelcome    = $true
    }
    if ($UseDeviceCode) {
        $connectParameters.UseDeviceCode = $true
    }

    Connect-MgGraph @connectParameters

    $context = Get-MgContext
    if ($null -eq $context -or $context.TenantId -ne $TenantId) {
        throw "Microsoft Graph tenant mismatch. Expected=$TenantId, Actual=$($context.TenantId)"
    }

    return $true
}

function Disconnect-EntraGraphSession {
    <#
    .SYNOPSIS
        Disconnects from Microsoft Graph only when Connect-EntraGraphSession established the connection.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool]$OwnsConnection
    )

    if ($OwnsConnection) {
        Disconnect-MgGraph | Out-Null
    }
}
