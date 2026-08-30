import { App } from "aws-cdk-lib";
import { WorkmateCostControlStack } from "./stack.js";

const app = new App({ analyticsReporting: false });
new WorkmateCostControlStack(app, "WorkmateCostControlStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
