export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  badge: string;
};

export function createAgentProfile(id: string, name: string, description: string): AgentProfile {
  const badge = Array.from(name).filter((character) => !/\s/u.test(character)).slice(0, 2).join("").toLocaleUpperCase();
  return {
    id,
    name,
    description,
    badge,
  };
}
