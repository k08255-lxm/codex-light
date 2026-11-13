import test from 'node:test';
import assert from 'node:assert/strict';
import { mountProjectNavigation } from '../public/project-navigation.js';
import {createDocument} from './mini-dom.mjs';

function setup() {
  const document=createDocument(),host=document.createElement('div');document.body.append(host);
  const calls=[];
  const navigation=mountProjectNavigation(host,{
    onSelect:group=>calls.push(['select',group]),onOpenThread:id=>calls.push(['open',id]),
    onRemove:group=>calls.push(['remove',group]),onAction:(group,action)=>calls.push([action,group]),
  });
  return {document,host,calls,...navigation};
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (node, className) => all(node).find(child => child.classList.contains(className));
const groups = host => all(host).filter(child => child.classList.contains('project-group'));
const projects = [{ id: 'a', path: 'C:\\Work\\A', name: 'Alpha' }, { id: 'b', path: '/work/b', name: 'Beta' }];
const threads = [{ id: 'c', cwd: '/history/c', name: 'History' }, { id: 'a1', cwd: 'c:/work/a/', name: 'Alpha thread' }, { id: 'unknown', name: 'Unknown directory' }];

test('saved projects lead historical directories; unknown cwd cannot select a project', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'c:/WORK/a/', activeThreadId: 'a1' });
  const result = groups(view.host);
  assert.deepEqual(result.map(group => find(group, 'project-group-select').textContent), ['Alpha', 'Beta', 'c', '其他对话']);
  assert.equal(result[0].classList.contains('selected'), false, 'an active conversation owns selection instead of its folder');
  assert.equal(find(result[0], 'project-group-toggle').attributes['aria-expanded'], 'true');
  assert.equal(find(result[0], 'project-group-select').title, 'C:\\Work\\A');
  assert.equal(find(result[0], 'project-group-thread').attributes['aria-current'], 'page');
  assert.equal(find(result[3], 'project-group-select').hidden, true);
  assert.equal(find(result[3], 'project-group-unknown').hidden, false);
  find(result[3], 'project-group-select').click();
  assert.deepEqual(view.calls, []);
  assert.equal(find(result[2], 'project-group-remove'), undefined,'no permanent remove button');
});

test('a user collapse survives normalized selectedPath and list refresh; changed selection opens its group', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  const first = groups(view.host)[0]; const toggle = find(first, 'project-group-toggle');
  toggle.click();
  view.render({ projects, threads, selectedPath: 'c:/WORK/a/' });
  assert.equal(groups(view.host)[0], first);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(find(first, 'project-group-threads').hidden, true);
  view.render({ projects, threads, selectedPath: '/work/b' });
  assert.equal(find(groups(view.host)[1], 'project-group-toggle').attributes['aria-expanded'], 'true');
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  assert.equal(toggle.attributes['aria-expanded'], 'true');
});

test('search opens all result groups while retaining the normal collapsed state', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  find(groups(view.host)[0], 'project-group-toggle').click();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A', searching: true });
  assert.equal(groups(view.host).length, 3);
  assert.ok(groups(view.host).every(group => find(group, 'project-group-toggle').attributes['aria-expanded'] === 'true'));
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  assert.equal(find(groups(view.host)[0], 'project-group-toggle').attributes['aria-expanded'], 'false');
});

test('separate buttons dispatch latest group/thread data and busy only blocks project mutations', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A', busy: true });
  const group = groups(view.host)[0];
  const select = find(group, 'project-group-select'); const more = find(group, 'project-group-action');
  assert.equal(select.disabled, true); assert.equal(more.disabled, true);
  select.click(); more.click(); assert.deepEqual(view.calls, []);
  find(group, 'project-group-thread').click(); assert.deepEqual(view.calls, [['open', 'a1']]);
  find(group, 'project-group-toggle').click();
  assert.equal(find(group, 'project-group-toggle').attributes['aria-expanded'], 'false');
  view.render({ projects: [{ ...projects[0], name: 'Renamed' }], threads, selectedPath: 'C:\\Work\\A' });
  select.click(); more.click();
  const menu=view.document.body.querySelector('.project-actions-menu');
  const remove=menu.querySelectorAll('button').find(button=>button.textContent==='移除项目');
  assert.ok(remove);remove.click();
  assert.equal(view.calls[1][0], 'select'); assert.equal(view.calls[1][1].name, 'Renamed');
  assert.equal(view.calls[2][0], 'remove'); assert.equal(view.calls[2][1].projectId, 'a');
  assert.equal(menu.hidden,true,'menu closes after the explicit remove action');
});

test('refresh reuses focused thread buttons, preserves scroll and renders all untrusted text literally', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  const group = groups(view.host)[0]; const button = find(group, 'project-group-thread');
  button.focus(); view.host.scrollTop = 67;
  view.render({ projects: [{ ...projects[0], name: '<img src=x>' }, projects[1]],
    threads: [{ ...threads[1], name: '<script>unsafe</script>' }, threads[0]], selectedPath: 'C:\\Work\\A', error: '<b>Failed</b>' });
  assert.equal(view.document.activeElement, button);
  assert.equal(find(groups(view.host)[0], 'project-group-thread'), button);
  assert.equal(view.host.scrollTop, 67);
  assert.equal(find(button, 'thread-name').textContent, '<script>unsafe</script>');
  assert.equal(find(view.host, 'project-navigation-error').textContent, '<b>Failed</b>');
  assert.ok(all(view.host).every(node => !['script', 'img', 'b'].includes(node.tag)));
});

test('empty and search empty states distinguish adding a project from no results', () => {
  const view = setup();
  view.render({ projects: [], threads: [] });
  const empty = find(view.host, 'project-navigation-empty');
  assert.equal(empty.hidden, false); assert.match(empty.textContent, /添加项目/);
  view.render({ projects, threads: [], searching: true });
  assert.equal(empty.textContent, '无搜索结果');
  assert.equal(groups(view.host).length, 0);
  view.render({ projects, threads: [] });
  assert.equal(empty.hidden, true);
});

test('selection moves between project draft and conversation with a single aria-current', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  const group = groups(view.host)[0], project = find(group, 'project-group-select');
  assert.equal(group.classList.contains('selected'), true);
  assert.deepEqual(view.host.querySelectorAll('[aria-current="page"]'), [project]);
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A', activeThreadId: 'a1' });
  const thread = find(group, 'project-group-thread');
  assert.equal(group.classList.contains('selected'), false);
  assert.equal(project.getAttribute('aria-current'), null);
  assert.equal(project.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(view.host.querySelectorAll('[aria-current="page"]'), [thread]);
  view.render({ projects, threads, selectedPath: '/work/b', activeThreadId: 'c' });
  assert.equal(thread.classList.contains('active'), false);
  assert.equal(thread.getAttribute('aria-current'), null);
  assert.equal(groups(view.host).filter(node => node.classList.contains('selected')).length, 0);
  assert.equal(view.host.querySelectorAll('[aria-current="page"]').length, 1);
});

test('running markers track actual running IDs independently from the active conversation', () => {
  const view = setup();
  view.render({ projects, threads, activeThreadId: 'c', runningThreadIds: new Set(['a1']) });
  const row = find(groups(view.host)[0], 'project-group-thread');
  const marker = find(row, 'thread-running-indicator');
  assert.equal(row.classList.contains('running'), true);
  assert.equal(row.classList.contains('active'), false);
  assert.equal(marker.hidden, false);
  assert.match(row.getAttribute('aria-label'), /Alpha thread · 运行中/);
  view.render({ projects, threads, activeThreadId: 'a1', runningThreadIds: new Set() });
  assert.equal(find(groups(view.host)[0], 'project-group-thread'), row, 'running updates retain the existing row');
  assert.equal(row.classList.contains('running'), false);
  assert.equal(row.classList.contains('active'), true);
  assert.equal(marker.hidden, true);
  assert.equal(row.getAttribute('aria-label'), 'Alpha thread');
  assert.equal(row.title, 'Alpha thread');
});
