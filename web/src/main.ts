import './style.css';
import { api, ApiError } from './lib/api';
import { resolveZone, todayIn } from './lib/dates';
import { h } from './lib/dom';
import { mountDesktop } from './desktop/desktop';
import { mountLogin } from './desktop/login';
import { errorDialog, unreachableDialog } from './ui/chrome';

// Boot: Login when there is no token, otherwise the desktop. The app timezone
// is fetched once; every window computes "today" from it.

const root = document.getElementById('desktop') as HTMLElement;

function boot(): void {
  if (api.hasToken()) void startApp(false);
  else showLogin();
}

function showLogin(): void {
  root.className = '';
  mountLogin(root, api, () => void startApp(true));
}

// `fresh`: straight after logging in, which is the only time the splash shows.
async function startApp(fresh: boolean): Promise<void> {
  root.replaceChildren(h('p', { className: 'desktop-loading', text: 'Starting PHT…' }));

  let zone: string;
  for (;;) {
    try {
      zone = resolveZone(await api.timezone());
      break;
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return showLogin();
      if (err instanceof ApiError && err.kind === 'network' && (await unreachableDialog())) continue;
      if (err instanceof ApiError && err.kind === 'network') {
        root.replaceChildren(
          h(
            'div',
            { className: 'desktop-offline' },
            h('p', { text: "Can't reach PHT." }),
            h('button', { type: 'button', text: 'Retry', on: { click: () => void startApp(fresh) } }),
          ),
        );
        return;
      }
      await errorDialog('PHT', err instanceof Error ? err.message : 'Something went wrong.');
      return showLogin();
    }
  }

  mountDesktop(root, {
    api,
    zone,
    today: () => todayIn(zone),
    splash: fresh,
    onSessionEnd: showLogin,
  });
}

boot();
