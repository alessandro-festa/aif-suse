import { describe, expect, it } from 'vitest';
import { codeCheck, codeFields, initialCodeSource } from '../code';

describe('training code', () => {
  it('starts on what the profile sets, else the inline script', () => {
    expect(initialCodeSource({ script: 'print(1)' })).toBe('script');
    expect(initialCodeSource({ configMap: 'train-code' })).toBe('configMap');
    expect(initialCodeSource({})).toBe('script');
  });

  it('needs a script or a ConfigMap unless the demo is chosen', () => {
    expect(codeCheck('script', { script: '  ', configMap: '' }).severity).toBe('fail');
    expect(codeCheck('configMap', { script: '', configMap: '' }).severity).toBe('fail');
    expect(codeCheck('script', { script: 'import torch', configMap: '' }).severity).toBe('pass');
    expect(codeCheck('demo', { script: '', configMap: '' }).severity).toBe('pass');
  });

  it('clears the fields of the sources not chosen', () => {
    expect(codeFields('demo', { script: 'x', configMap: 'c' })).toEqual({ script: '', configMap: '' });
    expect(codeFields('configMap', { script: 'x', configMap: 'c' })).toEqual({ script: '', configMap: 'c' });
  });
});
