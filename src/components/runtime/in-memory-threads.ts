type TitleSourceMessage = {
  role: string;
  content: readonly { type: string; text?: string }[];
};

export function generatedThreadTitle(messages: readonly TitleSourceMessage[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return undefined;
  const text = firstUserMessage.content
    .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? Array.from(text).slice(0, 60).join("") : undefined;
}
