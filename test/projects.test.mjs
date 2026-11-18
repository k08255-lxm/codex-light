import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectStore} from '../src/projects.mjs';
import {projectName, projectPathKey, projectThreadGroups} from '../public/projects.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-store-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  return {root, first, second, store: new ProjectStore({root: path.join(root, 'state')})};
}

test('missing registry is read only; projects and selection persist across reload', async t => {
  const {first, second, store} = await fixture(t);
  assert.deepEqual(await store.list(), {version: 1, projects: [], selectedId: null});
  await assert.rejects(stat(store.root), {code: 'ENOENT'});
  const added = await store.add(first), firstId = added.selectedId;
  assert.equal(added.projects[0].path, await realpath(first));
  assert.equal(added.projects[0].name, 'first');
  const secondAdded = await store.add(second);
  assert.notEqual(firstId, secondAdded.selectedId);
  const selected = await store.select(firstId);
  assert.deepEqual(await new ProjectStore({root: store.root}).list(), selected);
  assert.equal(selected.selectedId, firstId);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(store.file, 'utf8'))).sort(), ['projects', 'selectedId', 'version']);
});

test('canonical duplicate directory selects existing project and concurrent adds are serialized', async t => {
  const {first, second, store} = await fixture(t);
  const results = await Promise.all([store.add(first), store.add(second), store.add(path.join(first, '.'))]);
  const snapshot = await store.list();
  assert.equal(snapshot.projects.length, 2);
  assert.equal(snapshot.selectedId, results[0].selectedId);
  assert.equal(results[2].selectedId, results[0].selectedId);
  if (process.platform === 'win32') {
    const again = await store.add(first.toUpperCase());
    assert.equal(again.projects.length, 2);
    assert.equal(again.selectedId, results[0].selectedId);
  }
});

test('invalid directory inputs cannot change selection or persisted registry', async t => {
  const {root, first, store} = await fixture(t);
  const original = await store.add(first), bytes = await readFile(store.file, 'utf8');
  const file = path.join(root, 'plain-file');
  await writeFile(file, 'content');
  for (const input of ['', 'relative', first + '\0bad', 'x'.repeat(4097), path.join(root, 'missing'), file, null]) {
    await assert.rejects(store.add(input), /绝对项目文件夹|项目文件夹不存在/);
    assert.equal(await readFile(store.file, 'utf8'), bytes);
  }
  await assert.rejects(store.select('missing'), /找不到该项目/);
  assert.deepEqual(await store.list(), original);
});

test('selecting an unavailable saved directory leaves previous selection unchanged', async t => {
  const {first, second, store} = await fixture(t);
  const firstSnapshot = await store.add(first);
  const secondSnapshot = await store.add(second);
  await rm(first, {recursive: true});
  const before = await readFile(store.file, 'utf8');
  await assert.rejects(store.select(firstSnapshot.selectedId), /项目文件夹不存在/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.equal((await store.list()).selectedId, secondSnapshot.selectedId);
});

test('remove only changes registry and clears selection without selecting another project', async t => {
  const {first, second, store} = await fixture(t);
  const content = path.join(first, 'keep.txt');
  await writeFile(content, 'keep this project file');
  const firstId = (await store.add(first)).selectedId;
  await store.add(second);
  const afterUnselected = await store.remove(firstId);
  assert.equal(afterUnselected.projects.length, 1);
  assert.equal(afterUnselected.selectedId, afterUnselected.projects[0].id);
  const afterSelected = await store.remove(afterUnselected.selectedId);
  assert.deepEqual(afterSelected, {version: 1, projects: [], selectedId: null});
  assert.equal(await readFile(content, 'utf8'), 'keep this project file');
  assert.ok((await stat(second)).isDirectory());
  await store.add(first);
  const selectedSecond = await store.add(second);
  const remaining = await store.remove(selectedSecond.selectedId);
  assert.equal(remaining.projects.length, 1);
  assert.equal(remaining.selectedId, null);
});

test('corrupt JSON, bad schema and oversized files block updates without replacement', async t => {
  const {first, store} = await fixture(t);
  await mkdir(store.root);
  for (const contents of ['{bad', JSON.stringify({version: 1, projects: [], selectedId: 'orphan'}), JSON.stringify({version: 1, projects: [], selectedId: null, extra: true}), 'x'.repeat(128 * 1024 + 1)]) {
    await writeFile(store.file, contents);
    await assert.rejects(store.list(), /项目列表无法安全读取/);
    await assert.rejects(store.add(first), /项目列表无法安全读取/);
    assert.equal(await readFile(store.file, 'utf8'), contents);
  }
});

test('registry symlink is refused and target is untouched', async t => {
  const {root, first, store} = await fixture(t);
  await mkdir(store.root);
  const target = path.join(root, 'target.json');
  const contents = JSON.stringify({version: 1, projects: [], selectedId: null});
  await writeFile(target, contents);
  try { await symlink(target, store.file); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`当前环境不能创建符号链接（${error.code}）`);
    throw error;
  }
  await assert.rejects(store.add(first), /项目列表无法安全读取/);
  assert.equal(await readFile(target, 'utf8'), contents);
});

test('project ceiling keeps previous registry and failed jobs do not poison queue', async t => {
  const {root, first, store} = await fixture(t);
  const directories = Array.from({length: 50}, (_, index) => path.join(root, 'p' + index));
  await Promise.all(directories.map(directory => mkdir(directory)));
  await Promise.all(directories.map(directory => store.add(directory)));
  const before = await readFile(store.file, 'utf8');
  await assert.rejects(store.add(first), /最多保存 50/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  const repeated = await store.add(directories[0]);
  assert.equal(repeated.projects.length, 50);
  assert.equal(repeated.selectedId, repeated.projects[0].id);
});

test('path helpers normalize Windows drive and UNC paths while keeping POSIX case', () => {
  assert.equal(projectPathKey('C:\\Users\\TestUser\\demo-project\\'), 'c:/users/testuser/demo-project');
  assert.equal(projectPathKey('c:/USERS/testuser/DEMO-PROJECT/'), 'c:/users/testuser/demo-project');
  assert.equal(projectPathKey('C:\\'), 'c:/');
  assert.equal(projectPathKey('\\\\Server\\Share\\Project\\'), '//server/share/project');
  assert.equal(projectPathKey('//SERVER/share/Project/'), '//server/share/project');
  assert.equal(projectPathKey('\\\\?\\C:\\Work\\A'), projectPathKey('C:\\Work\\A'));
  assert.equal(projectPathKey('\\\\?\\UNC\\Server\\Share\\Project'), projectPathKey('\\\\Server\\Share\\Project'));
  assert.equal(projectPathKey('/Work/Project/'), '/Work/Project');
  assert.notEqual(projectPathKey('/Work/Project'), projectPathKey('/work/project'));
  assert.equal(projectPathKey('/'), '/');
  assert.equal(projectPathKey(null), '');
  assert.equal(projectPathKey('relative'), '');
  assert.equal(projectName('C:\\Users\\TestUser\\demo-project\\'), 'demo-project');
  assert.equal(projectName('C:\\'), 'C:\\');
  assert.equal(projectName('/work/project/'), 'project');
  assert.equal(projectName('/'), '/');
});

test('thread groups merge saved and historical directories without mutating inputs', () => {
  const projects = [{id: 'a', path: 'C:\\Work\\A', name: 'A'}, {id: 'empty', path: '/empty', name: 'empty'}];
  const threads = [{id: '1', cwd: 'c:/work/a/'}, {id: '2', cwd: '/history'}, {id: '3'}, {id: '4', cwd: 'relative'}];
  const before = JSON.stringify({projects, threads});
  const groups = projectThreadGroups(projects, threads, {selectedPath: 'C:/WORK/A'});
  assert.deepEqual(groups.map(group => [group.key, group.saved, group.selected, group.threads.map(thread => thread.id)]), [
    ['c:/work/a', true, true, ['1']], ['/empty', true, false, []], ['/history', false, false, ['2']], ['', false, false, ['3', '4']]
  ]);
  assert.equal(groups[0].projectId, 'a');
  assert.equal(groups[3].name, '其他对话');
  assert.equal(projectThreadGroups(projects, threads, {searching: true}).length, 3);
  assert.equal(JSON.stringify({projects, threads}), before);
});

test('project order preserves pins then promotes recently used projects without prioritizing running chats',()=>{
 const projects=[{id:'a',path:'/a'},{id:'b',path:'/b'},{id:'c',path:'/c'},{id:'pin',path:'/pin',pinned:true}];
 const threads=[{id:'a1',cwd:'/a',createdAt:100},{id:'a2',cwd:'/a',createdAt:90,updatedAt:1000},{id:'b',cwd:'/b',createdAt:200},{id:'c',cwd:'/c',createdAt:300}];
 assert.deepEqual(projectThreadGroups(projects,threads).map(row=>row.path),['/pin','/c','/b','/a']);
 const groups=projectThreadGroups(projects,threads,{runningThreadIds:new Set(['a2']),recent:{'/b':400}});
 assert.deepEqual(groups.map(row=>row.path),['/pin','/b','/c','/a']);
 const runningGroup=groups.find(row=>row.path==='/a');
 assert.equal(runningGroup.running,true);
 assert.equal(groups.find(row=>row.path==='/b').running,false);
 assert.deepEqual(runningGroup.threads.map(row=>row.id),['a1','a2']);
 assert.deepEqual(projectThreadGroups(projects,threads,{runningThreadIds:new Set(['a2']),recent:{'/b':400,'/c':500}}).map(row=>row.path),['/pin','/c','/b','/a']);
});

test('local project use takes precedence over newer background timestamps while unused projects use history',()=>{
 const projects=[{id:'a',path:'/a'},{id:'b',path:'/b'},{id:'c',path:'/c'},{id:'empty',path:'/empty'}];
 const threads=[{id:'a',cwd:'/a',updatedAt:900},{id:'b',cwd:'/b',updatedAt:200},{id:'c',cwd:'/c',createdAt:300}];
 const options={runningThreadIds:new Set(['a']),recent:{'/a':100,'/b':400}};
 const groups=projectThreadGroups(projects,threads,options);
 assert.deepEqual(groups.map(row=>row.path),['/b','/c','/a','/empty']);
 assert.equal(groups.find(row=>row.path==='/a').lastActivity,100000);
 assert.equal(groups.find(row=>row.path==='/empty').lastActivity,0);
 assert.deepEqual(projectThreadGroups(projects,threads,{...options,recent:{...options.recent,'/a':500}}).map(row=>row.path),['/a','/b','/c','/empty']);
});

test('project history fallback normalizes seconds and milliseconds and ignores invalid local timestamps',()=>{
 const projects=[{id:'a',path:'/a'},{id:'b',path:'/b'}];
 const threads=[{id:'a',cwd:'/a',createdAt:1700000000,updatedAt:1800000000000},{id:'b',cwd:'/b',createdAt:1700000001000}];
 const groups=projectThreadGroups(projects,threads,{recent:{'/a':'invalid','/b':-1}});
 assert.deepEqual(groups.map(row=>row.path),['/b','/a']);
 assert.deepEqual(groups.map(row=>row.lastActivity),[1700000001000,1700000000000]);
});

test('confirmed sends reorder conversations and their group; isolated workdirs stay in one projectless group',()=>{
 const projects=[{id:'a',path:'/a'},{id:'pin',path:'/pin',pinned:true},{id:'new',path:'/new',addedAt:30}];
 const threads=[{id:'older',cwd:'/a',createdAt:1,submittedAt:20},{id:'newer',cwd:'/a',createdAt:7,updatedAt:50},
  {id:'p1',cwd:'/independent/1',createdAt:10,projectless:true},{id:'p2',cwd:'/independent/2',createdAt:3,submittedAt:40,projectless:true}];
 const groups=projectThreadGroups(projects,threads);
 assert.deepEqual(groups.map(group=>group.key),['/pin','@projectless','/new','/a']);
 assert.equal(groups[1].name,'无项目');assert.equal(groups[1].path,'');
 assert.deepEqual(groups[1].threads.map(thread=>thread.id),['p2','p1']);
 assert.deepEqual(groups[3].threads.map(thread=>thread.id),['older','newer']);
});
