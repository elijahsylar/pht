import type { Api } from '../lib/api';
import type { DeskStore } from '../state/store';

// What every desktop window and floating window gets.
export interface Ctx {
  api: Api;
  store: DeskStore;
  // Today's date in the app timezone, computed fresh on every call so a page
  // left open past midnight moves on to the new day.
  today(): string;
  // The app timezone, for the taskbar clock and labels.
  zone: string;
  // Run a request, with the standard error handling: a 401 goes back to Login,
  // an unreachable API offers Retry (re-running `fn`), anything else shows an
  // error dialog. Resolves to undefined when it did not succeed.
  guard<T>(fn: () => Promise<T>, failTitle?: string): Promise<T | undefined>;
  // A line in the Today window's status bar.
  status(text: string): void;
  // Info for one habit, over the desktop (pushes /habit/:id).
  openInfo(id: number, opener?: HTMLElement | null): void;
  // A tray balloon, also read out through the live region.
  balloon(text: string): void;
  // True below 900px: windows stacked, no handles, no floating drags.
  isPhone(): boolean;
  // Put the Today deck on `date` (a day in the backfill window).
  openDay(date: string): void;
  // Save what is in flight (the note) and start the desktop again, e.g. after
  // the time zone changed: it is read once, at start.
  restart(): Promise<void>;
}
