const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../electron/store');

test('hotwords persist across database reopen and invalid replacement leaves saved words intact', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-hotwords-'));
  const options = { dbPath: path.join(directory, 'db.sqlite'), mediaDir: path.join(directory, 'media') };
  let store = createStore(options);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const words = [{ source: ' 七牛灵犀 ', target: ' Qiniu Lingxi ' }];
  store.setHotwords(words);
  assert.throws(() => store.setHotwords([{ source: '', target: 'invalid' }]), /热词原文/);
  assert.throws(() => store.setHotwords([{ source: 'same', target: 'one' }, { source: 'same', target: 'two' }]), /重复/);
  store.close(); store = createStore(options);
  assert.deepEqual(store.getHotwords(), [{ source: '七牛灵犀', target: 'Qiniu Lingxi' }]);
});
