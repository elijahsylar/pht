import { ApiError, type Api } from '../lib/api';
import { h } from '../lib/dom';
import { unreachableDialog } from '../ui/chrome';

// The existing two-step login, as a 98 dialog: password, then the security
// answer. On success the API client has stored the JWT (localStorage
// `pht:token`) and `onDone` builds the app.
export function mountLogin(desktop: HTMLElement, api: Api, onDone: () => void): void {
  desktop.replaceChildren();
  document.title = 'Log On - PHT';

  const message = h('p', { className: 'login-message', attrs: { role: 'alert' } });
  const body = h('div', { className: 'window-body' });
  const win = h(
    'div',
    { className: 'window login-window', attrs: { role: 'dialog', 'aria-labelledby': 'login-title' } },
    h(
      'div',
      { className: 'title-bar' },
      h('div', { className: 'title-bar-text', id: 'login-title', text: 'Log On to PHT' }),
    ),
    body,
  );
  desktop.append(win);

  const say = (text: string) => {
    message.textContent = text;
  };

  async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'network') {
          if (await unreachableDialog()) continue;
          return undefined;
        }
        say(err instanceof ApiError ? friendly(err) : 'Something went wrong.');
        return undefined;
      }
    }
  }

  function passwordStep() {
    const user = h('input', { type: 'text', id: 'login-user', autocomplete: 'username', required: true });
    const pass = h('input', {
      type: 'password',
      id: 'login-pass',
      autocomplete: 'current-password',
      required: true,
    });
    const ok = h('button', { type: 'submit', className: 'default', text: 'OK' });
    const form = h(
      'form',
      { className: 'login-form', attrs: { novalidate: '' } },
      h('p', { text: 'Type a user name and password to log on to PHT.' }),
      h('div', { className: 'field-row-stacked' }, h('label', { htmlFor: 'login-user', text: 'User name:' }), user),
      h('div', { className: 'field-row-stacked' }, h('label', { htmlFor: 'login-pass', text: 'Password:' }), pass),
      message,
      h('div', { className: 'dialog-buttons' }, ok),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!user.value || !pass.value) return say('Enter your user name and password.');
      ok.disabled = true;
      say('Checking…');
      const partial = await attempt(() => api.login(user.value.trim(), pass.value));
      ok.disabled = false;
      if (partial) {
        say('');
        answerStep(partial);
      }
    });
    body.replaceChildren(form);
    user.focus();
  }

  function answerStep(partial: string) {
    const answer = h('input', { type: 'password', id: 'login-answer', autocomplete: 'off', required: true });
    const ok = h('button', { type: 'submit', className: 'default', text: 'OK' });
    const back = h('button', { type: 'button', text: 'Cancel', on: { click: () => passwordStep() } });
    const form = h(
      'form',
      { className: 'login-form', attrs: { novalidate: '' } },
      h('p', { text: 'Answer your security question to finish logging on.' }),
      h(
        'div',
        { className: 'field-row-stacked' },
        h('label', { htmlFor: 'login-answer', text: 'Security answer:' }),
        answer,
      ),
      message,
      h('div', { className: 'dialog-buttons' }, ok, back),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!answer.value) return say('Enter the answer.');
      ok.disabled = true;
      say('Checking…');
      const done = await attempt(async () => {
        await api.verifySecurity(partial, answer.value);
        return true;
      });
      ok.disabled = false;
      if (done) onDone();
      // An expired partial token (10 minutes) means starting over.
      else if (message.textContent === 'Please log in again.') passwordStep();
    });
    body.replaceChildren(form);
    answer.focus();
  }

  passwordStep();
}

function friendly(err: ApiError): string {
  if (err.status === 401 && err.message === 'incorrect answer') return 'That answer is not right.';
  if (err.status === 401 && err.message === 'invalid token') return 'Please log in again.';
  if (err.status === 401) return 'The user name or password is not right.';
  if (err.status === 400) return 'Fill in every field.';
  return err.message;
}
