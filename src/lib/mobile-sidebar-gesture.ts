export type SwipePoint = { x: number; y: number };

const MOBILE_MAX_WIDTH = 767;
const START_EDGE_WIDTH = 72;
const MIN_HORIZONTAL_DISTANCE = 72;
const MAX_VERTICAL_DISTANCE = 48;
const HORIZONTAL_DOMINANCE = 1.5;

export function isMobileSidebarOpeningSwipe(
  start: SwipePoint,
  end: SwipePoint,
  viewportWidth: number,
): boolean {
  if (viewportWidth > MOBILE_MAX_WIDTH || start.x > START_EDGE_WIDTH) return false;
  const horizontal = end.x - start.x;
  const vertical = Math.abs(end.y - start.y);
  return horizontal >= MIN_HORIZONTAL_DISTANCE
    && vertical <= MAX_VERTICAL_DISTANCE
    && horizontal >= vertical * HORIZONTAL_DOMINANCE;
}
