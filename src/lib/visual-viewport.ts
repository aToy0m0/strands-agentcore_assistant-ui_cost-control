export type AppViewport = {
  height: number;
  offsetTop: number;
  keyboardOpen: boolean;
};

export function resolveAppViewport(
  layoutHeight: number,
  viewport?: { height: number; offsetTop: number },
  mobile = false,
): AppViewport {
  const height = Math.max(1, Math.round(viewport?.height ?? layoutHeight));
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
  return {
    height,
    offsetTop,
    keyboardOpen: mobile && layoutHeight - height >= 150,
  };
}
