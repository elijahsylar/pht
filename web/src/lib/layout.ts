// The desktop's five windows, in their phone (stacking) order: Learned
// stacks after History.

export const WINDOWS = ['today', 'history', 'learned', 'weather', 'wire'] as const;
export type WindowName = (typeof WINDOWS)[number];
