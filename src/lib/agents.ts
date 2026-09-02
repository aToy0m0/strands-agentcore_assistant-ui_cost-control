export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  badge: string;
};

export function createAgentProfile(name: string): AgentProfile {
  const badge = Array.from(name).filter((character) => !/\s/u.test(character)).slice(0, 2).join("").toLocaleUpperCase();
  return {
    id: "workmate",
    name,
    description: "AgentCore Runtime上で動作する単一エージェント",
    badge,
  };
}
