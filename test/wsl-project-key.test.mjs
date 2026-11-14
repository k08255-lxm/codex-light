import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPathKey,projectThreadGroups} from '../public/projects.js';
test('WSL aliases normalize but Linux path case remains significant',()=>{
 assert.equal(projectPathKey('\\\\wsl$\\Ubuntu\\home\\Lee\\Repo'),projectPathKey('//WSL.LOCALHOST/ubuntu/home/Lee/Repo/'));
 assert.notEqual(projectPathKey('//wsl.localhost/Ubuntu/home/Lee/Repo'),projectPathKey('//wsl.localhost/Ubuntu/home/Lee/repo'));
 assert.equal(projectThreadGroups([{id:'a',path:'//wsl$/Ubuntu/home/Lee/Repo'},{id:'b',path:'//wsl.localhost/Ubuntu/home/Lee/repo'}],[]).length,2);
});
test('ordinary Windows paths stay case insensitive and Linux paths stay case sensitive',()=>{
 assert.equal(projectPathKey('C:\\Work\\Repo'),projectPathKey('c:/work/repo'));
 assert.equal(projectPathKey('\\\\server\\Share\\Repo'),projectPathKey('//SERVER/share/repo'));
 assert.notEqual(projectPathKey('/home/Lee/Repo'),projectPathKey('/home/Lee/repo'));
});
