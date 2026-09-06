import { App } from "aws-cdk-lib";
import { resolveResourceNames } from "./naming.js";
import { AgentCoreCostControlStack } from "./stack.js";

const app = new App({ analyticsReporting: false });
const names = resolveResourceNames(app.node.tryGetContext("defaultCdkPrefix"));
new AgentCoreCostControlStack(app, "AgentCoreCostControlStack", {
  stackName: names.stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
