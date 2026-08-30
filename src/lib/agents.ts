export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  badge: string;
};

export const agent: AgentProfile = {
  id: "workmate",
  name: "Workmate",
  description: "AgentCore Runtime上で動作する単一エージェント",
  badge: "WM",
};
