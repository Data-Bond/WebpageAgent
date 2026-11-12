import test from 'node:test';
import assert from 'node:assert/strict';
import { applyModelEnvText, MODEL_ENV_KEYS } from './browsers.mjs';

test('model.env 的键在环境变量为空时生效', () => {
  const env = applyModelEnvText(
    '# comment\n\nWPA_EVAL_BASE_URL=http://127.0.0.1:9/v1\nWPA_EVAL_API_KEY="sk-test"\nWPA_EVAL_MODEL=\'m\'\n',
    {},
    'model.env'
  );
  assert.equal(env.WPA_EVAL_BASE_URL, 'http://127.0.0.1:9/v1');
  assert.equal(env.WPA_EVAL_API_KEY, 'sk-test');
  assert.equal(env.WPA_EVAL_MODEL, 'm');
});

test('同名环境变量优先于文件', () => {
  const env = applyModelEnvText('WPA_EVAL_MODEL=from-file\n', { WPA_EVAL_MODEL: 'from-env' }, 'model.env');
  assert.equal(env.WPA_EVAL_MODEL, 'from-env');
});

test('不认识的键报错', () => {
  assert.throws(() => applyModelEnvText('API_KEY=x\n', {}, 'model.env'), /不认识的键 API_KEY/);
});

test('可填写的键覆盖模型与 OCR', () => {
  assert.ok(MODEL_ENV_KEYS.includes('WPA_EVAL_OCR_BASE_URL'));
  assert.ok(MODEL_ENV_KEYS.includes('WPA_EVAL_MAX_STEPS'));
});
