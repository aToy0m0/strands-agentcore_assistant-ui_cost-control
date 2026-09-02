@{
  Profile              = "default"
  Region               = "us-east-1"
  ResourceNamePrefix   = "workmate"
  UiName               = "Workmate"
  WebDebugMode         = "off"
  CognitoDomainPrefix  = "<unique-domain-prefix>"
  CustomDomainEnabled  = $false
  CustomDomainName     = "<app-subdomain.example.com>"
  HostedZoneId         = "<route53-hosted-zone-id>"
  HostedZoneName       = "<example.com>"
  CertificateArn       = "<us-east-1-acm-certificate-arn>"
  KnowledgeBaseId     = "<bedrock-knowledge-base-id>"
  EntraEnabled         = $false
  EntraTenantId        = ""
  EntraClientId        = ""
  EntraClientSecretName = ""
  LoginMethods         = "cognito"
  LogRetentionDays     = 30
  RuntimeLogRequest    = "on"
  RuntimeLogModel      = "on"
  RuntimeLogTool       = "on"
  AccountMonthlyBudgetUsd = "100"
  ProjectMonthlyBudgetUsd = "60"
  UserLimitProfiles = @(
    @{ id = "default"; default = $true;  window = "monthly"; tokenLimit = 1000000 }
    @{ id = "weekly";  default = $false; window = "weekly";  tokenLimit = 250000 }
    @{ id = "daily";   default = $false; window = "daily";   tokenLimit = 50000 }
  )
}
