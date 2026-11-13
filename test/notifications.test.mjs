import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotifications} from '../public/ui/notifications.js';

function fixture() {
  const target = () => {
    const classes = new Set(['hidden']);
    const span = {textContent: ''};
    return {span, classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle: (value, on) => on ? classes.add(value) : classes.delete(value)}, querySelector: () => span};
  };
  const main = target(), settings = target(), timers = [], cleared = [];
  let active = main;
  const controller = createNotifications({targets: [main, settings], activeTarget: () => active, setTimer: (callback, delay) => {timers.push({callback, delay});return timers.length;}, clearTimer: id => cleared.push(id)});
  return {main, settings, timers, cleared, controller, useSettings: () => {active = settings;}};
}

test('messages expire after five seconds, including errors', () => {
  const f = fixture();
  f.controller.show('错误', true);
  assert.equal(f.main.span.textContent, '错误');
  assert.equal(f.main.classList.contains('error'), true);
  assert.equal(f.main.classList.contains('hidden'), false);
  assert.equal(f.timers[0].delay, 5000);
  f.timers[0].callback();
  assert.equal(f.main.classList.contains('hidden'), true);
});

test('new message resets deadline and stale callbacks cannot dismiss it', () => {
  const f = fixture();
  f.controller.show('first', true);
  f.controller.show('second');
  assert.deepEqual(f.cleared, [1]);
  f.timers[0].callback();
  assert.equal(f.main.classList.contains('hidden'), false);
  assert.equal(f.main.classList.contains('error'), false);
  assert.equal(f.main.span.textContent, 'second');
  f.timers[1].callback();
  assert.equal(f.main.classList.contains('hidden'), true);
});

test('settings receive a single message and manual dismissal clears the timer', () => {
  const f = fixture();
  f.controller.show('main');
  f.useSettings();
  f.controller.show('settings');
  assert.equal(f.main.classList.contains('hidden'), true);
  assert.equal(f.settings.classList.contains('hidden'), false);
  f.controller.dismiss();
  assert.deepEqual(f.cleared, [1, 2]);
  assert.equal(f.settings.classList.contains('hidden'), true);
  f.controller.show('new');
  f.timers[1].callback();
  assert.equal(f.settings.classList.contains('hidden'), false);
});
